import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMetrics, summarizeMetrics, periodStart, tokenParts, recordedCost, comparePeriod} from '../src/js/core/metrics.js';
const epoch=s=>Date.parse(s)/1000;
const row=(id,at,input=100,cached=40,output=10,extra={})=>({id,at,runId:'run',harness:'codex',sessionId:'session',model:'example',type:'usage',usage:{kind:'tokens',scope:'turn',inputTokens:input,cacheReadTokens:cached,outputTokens:output},...extra});
test('stacked tokens never add cached input twice, including inconsistent cache readings',()=>{
 assert.deepEqual(tokenParts({inputTokens:100,cacheReadTokens:140,outputTokens:20}),{uncached:0,cached:100,output:20});
 const report=summarizeMetrics(normalizeMetrics([row(1,100)]),{range:'all'},101);
 assert.equal(report.points.reduce((sum,p)=>sum+p.uncached+p.cached+p.output,0),report.tokens);
});
test('31-day and preceding periods use local calendar arithmetic across DST',()=>{
 const previous=process.env.TZ;process.env.TZ='America/New_York';
 try {
 const now=epoch('2026-11-10T12:00:00-05:00');
 assert.equal(periodStart('31d',now),epoch('2026-10-10T12:00:00-04:00'));
 const report=summarizeMetrics(normalizeMetrics([row(1,periodStart('31d',now)-1,50),row(2,periodStart('31d',now)),row(3,now+1,999)]),{range:'31d'},now);
 assert.equal(report.tokens,110);assert.equal(report.previous,60);
 assert.equal(report.comparison.absolute,50);
 assert.ok(report.points.every(p=>new Date(p.at*1000).getHours()===0));
 } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
test('zero baselines do not manufacture percentage growth',()=>{
 assert.deepEqual(comparePeriod(100,0),{absolute:100,percent:null});
 assert.deepEqual(comparePeriod(0,100),{absolute:-100,percent:-100});
});
test('cost coverage excludes missing, estimated, cumulative and non-USD amounts',()=>{
 const cost={kind:'recorded',scope:'turn',currency:'USD',amount:0.25};
 const records=[row(1,100,100,40,10,{cost}),row(2,101),row(3,102,100,40,10,{cost:{...cost,kind:'estimate'}}),row(4,103,100,40,10,{cost:{...cost,scope:'session'}})];
 const report=summarizeMetrics(normalizeMetrics(records),{range:'all'},104);
 assert.equal(report.cost,0.25);assert.equal(report.costCoverage,0.25);assert.equal(report.costTokens,110);
 assert.equal(recordedCost({cost:{...cost,currency:'EUR'}}),null);
 assert.equal(recordedCost({cost:{...cost,amount:0}}),0);
 assert.equal(summarizeMetrics(normalizeMetrics([row(1,100)]),{range:'all'},104).cost,null);
});
test('sparse all-time histories bound chart size and retain exact totals',()=>{
 const rows=normalizeMetrics([row(1,epoch('2000-01-01')),row(2,epoch('2026-10-12'),1000000000000,20,99)]);
 const report=summarizeMetrics(rows,{range:'all'},epoch('2026-10-13'));
 assert.ok(report.points.length<=64);assert.equal(report.tokens,1000000000209);
 assert.equal(report.comparison,null);
});
test('24-hour buckets distinguish repeated fall-back hours',()=>{
 const previous=process.env.TZ;process.env.TZ='America/New_York';
 try {
 const a=epoch('2026-11-01T01:30:00-04:00'),b=epoch('2026-11-01T01:30:00-05:00');
 const report=summarizeMetrics(normalizeMetrics([row(1,a),row(2,b)]),{range:'24h'},b+3600);
 assert.equal(report.points.filter(p=>p.total).length,2);
 } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
test('empty histories have no claimed cost, cache rate, or most-used model',()=>{
 const report=summarizeMetrics([],{range:'all'},100);
 assert.equal(report.cost,null);assert.equal(report.cacheRate,null);assert.deepEqual(report.models,[]);
});

test('job occurrences use the selected period and filters, deduplicate resumes, retain nonterminal states',async()=>{
 const {summarizeJobRuns}=await import('../src/js/core/metrics.js');
 const run={runId:'one',taskId:'job',startedAt:100000,harness:'codex',model:'model',status:'completed'};
 const data=[run,run,{...run,runId:'two',status:'waiting'},{...run,runId:'old',startedAt:100},{...run,runId:'claude',harness:'claude'}];
 assert.deepEqual(summarizeJobRuns(data,{range:'24h',harness:'codex'},100001),{completed:1,failed:0,waiting:1,running:0,other:0,total:2,jobs:1});
});
