import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMetrics,summarizeMetrics} from '../src/js/core/metrics.js';
const session=(id,run,at=100)=>({id,at,runId:run,harness:'codex',model:'model-a',type:'session',sessionId:'session-a'});
const usage=(id,run,input,output,at=100,extra={})=>({id,at,runId:run,harness:'codex',model:'model-a',type:'usage',usage:{kind:'tokens',scope:'session',inputTokens:input,outputTokens:output,cacheReadTokens:0,...extra}});
test('session totals are differenced across runs before date filtering',()=>{
 const rows=normalizeMetrics([session(1,'one'),usage(2,'one',100,10),session(3,'two',200000),usage(4,'two',160,30,200000,{resumed:true})]);
 const all=summarizeMetrics(rows,{range:'all'},200001);
 assert.equal(all.tokens,190);
 const recent=summarizeMetrics(rows,{range:'24h'},200001);
 assert.equal(recent.tokens,80);
 assert.equal(recent.runs,1);
});
test('unknown resumed baseline is omitted, and cached input is not added twice',()=>{
 const rows=normalizeMetrics([session(1,'one'),usage(2,'one',100,10,100,{resumed:true,cacheReadTokens:80}),usage(3,'one',150,20,101,{resumed:true,cacheReadTokens:110})]);
 const report=summarizeMetrics(rows,{range:'all'},102);
 assert.equal(report.tokens,60);assert.equal(report.cached,30);assert.equal(report.baselineOnly,1);
});
test('harness and model filters include only matching data and deduplicate events',()=>{
 const tool={id:1,at:100,runId:'one',harness:'claude',model:'model-b',type:'activity',tool:'Read'};
 const rows=normalizeMetrics([tool,tool,usage(2,'two',100,10)]);
 assert.equal(summarizeMetrics(rows,{range:'all'},102).toolCount,1);
 assert.equal(summarizeMetrics(rows,{range:'all',harness:'claude',model:'model-b'},102).usageReports,0);
 assert.equal(summarizeMetrics(rows,{range:'all',model:'model-a'},102).tokens,110);
});
test('Claude model counters remain separate and do not double count resumed totals',()=>{
 const a={...usage(2,'one',100,10),harness:'claude',sessionId:'claude-session',model:'a'};a.usage.perModel=true;
 const b={...a,id:3,model:'b',usage:{...a.usage,inputTokens:20,outputTokens:2}};
 const repeat={...a,id:4,at:101,runId:'two',usage:{...a.usage,inputTokens:130,outputTokens:13,resumed:true}};
 const report=summarizeMetrics(normalizeMetrics([a,b,repeat]),{range:'all'},102);
 assert.equal(report.tokens,165);assert.equal(report.groups.length,2);
});
test('string record IDs are normalized in timestamp order',()=>{
 const rows=normalizeMetrics([
  {...usage('local:z','one',150,20,101),sessionId:'session-a'},
  {...usage('local:a','one',100,10,100),sessionId:'session-a'}
 ]);
 assert.deepEqual(rows.map(row=>row.at),[100,101]);
 assert.equal(summarizeMetrics(rows,{range:'all'},102).tokens,170);
});
test('daily totals use local calendar dates and include cached input without adding it twice',()=>{
 const original=process.env.TZ;
 process.env.TZ='Etc/GMT+5';
 try {
  const first=Date.parse('2026-10-09T23:30:00Z')/1000;
  const second=Date.parse('2026-10-10T01:30:00Z')/1000;
  const rows=normalizeMetrics([
   {...usage('local:a','one',100,10,first,{scope:'turn',cacheReadTokens:40}),sessionId:'session-a'},
   {...usage('local:b','one',50,5,second,{scope:'turn',cacheReadTokens:20}),sessionId:'session-a'},
   {id:'local:c',at:second,runId:'one',harness:'codex',model:'model-a',type:'activity',tool:'Read'}
  ]);
  const report=summarizeMetrics(rows,{range:'7d'},second+1);
  assert.equal(report.daily.length,1);
  assert.deepEqual([report.daily[0].input,report.daily[0].output,report.daily[0].cached,report.daily[0].total,report.daily[0].tools],[150,15,60,165,1]);
  assert.equal(report.points.filter(point=>point.total>0).length,1);
  assert.equal(new Date(report.daily[0].at*1000).getHours(),0);
 } finally {if(original===undefined)delete process.env.TZ;else process.env.TZ=original;}
});
