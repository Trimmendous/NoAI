// Normalize recorded CLI usage before filtering: session counters must be differenced
// across all observed history, including observations outside the selected range.
export function normalizeMetrics(records = []) {
  const sessions = new Map(), contexts = new Map(), counters = new Map(), seen = new Set();
  const output = [];
  for (const record of [...records].sort((a,b) => a.at-b.at || (typeof a.id === 'number' && typeof b.id === 'number' ? a.id-b.id : String(a.id ?? '').localeCompare(String(b.id ?? ''))))) {
    const id = record.id ?? `${record.runId}:${record.eventId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const previousContext = contexts.get(record.runId) || {};
    const context = {harness:record.harness || previousContext.harness || 'unknown', model:record.model ?? previousContext.model ?? ''};
    contexts.set(record.runId, context);
    if (record.sessionId) sessions.set(record.runId, record.sessionId);
    const row = {...record, ...context, sessionId:record.sessionId || sessions.get(record.runId), inputTokens:0, outputTokens:0, cacheReadTokens:0, reported:false, baselineOnly:false};
    if (record.usage?.kind === 'tokens') {
      const usage = record.usage;
      const values = [usage.inputTokens,usage.outputTokens,usage.cacheReadTokens ?? 0];
      if (values.every(value => Number.isSafeInteger(value) && value >= 0)) {
        let counts = values;
        if (usage.scope === 'session') {
          const key = JSON.stringify([context.harness, record.sessionId || sessions.get(record.runId) || record.runId, usage.perModel ? context.model : '']);
          const prior = counters.get(key);
          counters.set(key, values);
          if (prior) counts = values.map((value,index) => value >= prior[index] ? value-prior[index] : value);
          else if (usage.resumed) { counts = [0,0,0]; row.baselineOnly = true; }
        }
        [row.inputTokens,row.outputTokens,row.cacheReadTokens] = counts;
        row.reported = !row.baselineOnly;
      }
    }
    if (Number.isFinite(row.at) && row.at > 0) output.push(row);
  }
  return output;
}

// Rolling 24 hours; longer periods preserve the local wall-clock across DST.
export function periodStart(range, now) {
  if (range === 'all') return null;
  if (range === '24h') return now - 86400;
  const date = new Date(now * 1000);
  date.setDate(date.getDate() - ({'7d':7,'31d':31,'30d':30}[range] || 7));
  return date.getTime()/1000;
}
export function tokenParts(row) {
  const cached = Math.min(row.inputTokens || 0, row.cacheReadTokens || 0);
  return {uncached:(row.inputTokens || 0)-cached,cached,output:row.outputTokens || 0};
}
export function comparePeriod(current, previous) {
  return {absolute:current-previous,percent:previous ? (current-previous)/previous*100 : null};
}
// Only explicit per-event USD costs are additive. Never interpret cumulative costs,
// token counts, or account-plan prices as charges. No price estimates are inferred.
export function recordedCost(row) {
  const cost = row.cost;
  return cost?.kind === 'recorded' && cost.scope === 'turn' && cost.currency === 'USD'
    && Number.isFinite(cost.amount) && cost.amount >= 0 ? cost.amount : null;
}
// Outcome rows recorded from agent transcripts, by the field they count into.
const OUTCOME_KEYS = {tool_ok:'toolOk', tool_error:'toolError', connection_error:'connection', rate_limit:'rateLimit', api_error:'apiError'};
const emptyOutcomes = () => ({responses:0,toolOk:0,toolError:0,connection:0,rateLimit:0,apiError:0});
/** Successful calls (model responses + tool calls that worked) and each kind of failure. */
export function outcomeTotals(counts) {
  const ok=counts.responses+counts.toolOk, errors=counts.toolError+counts.connection+counts.rateLimit+counts.apiError;
  return {ok,errors,rate:ok+errors ? ok/(ok+errors) : null};
}
export function summarizeMetrics(rows, {harness='',model='',range='7d'} = {}, now = Date.now()/1000) {
  const matches = row => (!harness || row.harness===harness) && (!model || (row.model || '__default__')===model);
  const eligible = rows.filter(row => Number.isFinite(row.at) && row.at > 0 && row.at <= now && matches(row));
  const from = periodStart(range,now) ?? eligible.reduce((min,row)=>Math.min(min,row.at),now);
  const previousFrom = periodStart(range,from);
  const filtered = eligible.filter(row => row.at >= from);
  const previous = previousFrom === null ? null : eligible.filter(row => row.at >= previousFrom && row.at < from).reduce((sum,row)=>sum+(row.reported ? row.inputTokens+row.outputTokens : 0),0);
  const localDay = timestamp => {const date=new Date(timestamp*1000);date.setHours(0,0,0,0);return date.getTime()/1000;};
  const days = Math.max(1,Math.ceil((now-from)/86400));
  const bucketDays = Math.max(1,Math.ceil(days/62));
  const step = range === '24h' || range === 'all' && days <= 2 ? 3600 : bucketDays*86400;
  const startDate = new Date(from*1000);
  if(step===3600) startDate.setMinutes(0,0,0); else startDate.setHours(0,0,0,0);
  const points=[];
  const empty = at => ({at,total:0,input:0,uncached:0,output:0,cached:0,tools:0,cost:0,costReports:0,usageReports:0,...emptyOutcomes()});
  while(startDate.getTime()/1000<=now) {
    points.push(empty(startDate.getTime()/1000));
    if(step===3600) startDate.setTime(startDate.getTime()+3600000); else startDate.setDate(startDate.getDate()+bucketDays);
  }
  const runs=new Set(), completed=new Set(), failed=new Set(), toolNames=new Map(), groups=new Map(), daily=new Map(), harnesses=new Map(), models=new Map();
  let input=0,output=0,cached=0,toolCount=0,usageReports=0,baselineOnly=0,cost=0,costReports=0,costTokens=0;
  const outcomes=emptyOutcomes();
  for(const row of filtered) {
    runs.add(`${row.harness}:${row.sessionId || row.runId}`);
    if(row.type==='done' && !row.cancelled) completed.add(row.runId);
    if(row.type==='error') failed.add(row.runId);
    let lo=0,hi=points.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(points[mid].at<=row.at)lo=mid+1;else hi=mid;}
    const point=points[Math.max(0,lo-1)];
    const day=localDay(row.at);
    if(!daily.has(day))daily.set(day,empty(day));
    const dayRow=daily.get(day);
    const key=JSON.stringify([row.harness,row.model]);
    if(!groups.has(key))groups.set(key,{harness:row.harness,model:row.model,tokens:0,tools:0,runs:new Set(),reported:false});
    const group=groups.get(key);group.runs.add(row.sessionId || row.runId);
    if(row.reported) {
      const parts=tokenParts(row), total=row.inputTokens+row.outputTokens, amount=recordedCost(row);
      usageReports++;input+=row.inputTokens;output+=row.outputTokens;cached+=parts.cached;
      if(amount!==null){cost+=amount;costReports++;costTokens+=total;}
      outcomes.responses++;point.responses++;
      for(const bucket of [point,dayRow]) {
        bucket.input+=row.inputTokens;bucket.total+=total;bucket.usageReports++;
        for(const name of ['uncached','cached','output'])bucket[name]+=parts[name];
        if(amount!==null){bucket.cost+=amount;bucket.costReports++;}
      }
      group.tokens+=total;group.reported=true;
      harnesses.set(row.harness,(harnesses.get(row.harness)||0)+total);
      const name=row.model || 'Not reported';models.set(name,(models.get(name)||0)+total);
    }
    if(row.baselineOnly)baselineOnly++;
    const outcome=OUTCOME_KEYS[row.type==='outcome' ? row.outcome : ''];
    if(outcome){outcomes[outcome]++;point[outcome]++;}
    if(row.type==='activity') {
      toolCount++;point.tools++;group.tools++;dayRow.tools++;
      const name=row.tool || 'Unnamed tool';toolNames.set(name,(toolNames.get(name)||0)+1);
    }
  }
  const shares = map => [...map].map(([name,tokens])=>({name,tokens})).sort((a,b)=>b.tokens-a.tokens);
  return {points,outcomes,daily:[...daily.values()].sort((a,b)=>b.at-a.at),from,step,input,output,cached,tokens:input+output,toolCount,usageReports,baselineOnly,runs:runs.size,completed:completed.size,failed:failed.size,
    cost:costReports?cost:null,costReports,costTokens,costCoverage:usageReports?costReports/usageReports:null,
    comparison:previous===null?null:comparePeriod(input+output,previous),previous,
    harnesses:shares(harnesses),models:shares(models),cacheRate:input?cached/input:null,
    tools:[...toolNames].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count),
    groups:[...groups.values()].map(group=>({...group,runs:group.runs.size})).sort((a,b)=>b.tokens-a.tokens || b.tools-a.tools)};
}

export function summarizeJobRuns(runs, {range='7d',harness='',model=''}={}, now=Date.now()/1000) {
  const from=periodStart(range,now) ?? 0;
  const unique=new Map(runs.map(run=>[run.runId,run]));
  const selected=[...unique.values()].filter(run=>run.startedAt>=from&&run.startedAt<=now&&(!harness||run.harness===harness)&&(!model||(run.model||'__default__')===model));
  const counts={completed:0,failed:0,waiting:0,running:0,other:0};
  for(const run of selected)counts[Object.hasOwn(counts,run.status)?run.status:'other']++;
  return {...counts,total:selected.length,jobs:new Set(selected.map(run=>run.taskId)).size};
}
