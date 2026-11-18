import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSession } from '../src/js/components/session-stats.js';
import { normalizeMetrics } from '../src/js/core/metrics.js';

const task = {harness:'codex', model:'configured'};
const tokens = (input, output, cached = 0) => ({kind:'tokens', scope:'session', inputTokens:input, outputTokens:output, cacheReadTokens:cached});

test('session stats difference cumulative usage and include cache only once', () => {
  const run = {runId:'r', startedAt:100, finishedAt:200, resumeAttempts:2, events:[
    {type:'usage', at:110, model:'actual', usage:tokens(100, 20, 30)},
    {type:'usage', at:120, model:'actual', usage:tokens(150, 40, 50)},
    {type:'activity', at:130, text:'Read'}, {type:'activity', at:140, text:'Read'},
    {type:'waiting', at:150}, {type:'error', at:160},
  ]};
  const result = summarizeSession(task, run);
  assert.equal(result.total, 190);
  assert.equal(result.cached, 50);
  assert.equal(result.elapsed, 100);
  assert.equal(result.resumes, 2);
  assert.equal(result.waits, 1);
  assert.equal(result.errors, 1);
  assert.deepEqual(result.tools, [['Read', 2]]);
  assert.equal(result.models[0].name, 'actual');
});

test('imported provider session metrics replace saved usage without counting unrelated sessions', () => {
  const run = {runId:'r', startedAt:100, events:[
    {type:'session', at:101, resumeId:'provider'},
    {type:'usage', at:102, usage:tokens(10, 1)},
  ]};
  const rows = normalizeMetrics([
    {id:1, runId:'local:codex:provider', sessionId:'provider', harness:'codex', model:'actual', at:105, type:'usage', usage:tokens(200, 50, 60)},
    {id:2, runId:'other', sessionId:'unrelated', harness:'codex', at:110, type:'usage', usage:tokens(500, 500)},
    {id:3, runId:'other-harness', sessionId:'provider', harness:'claude', at:115, type:'usage', usage:tokens(500, 500)},
  ]);
  assert.equal(summarizeSession(task, run, rows).total, 250);
});

test('unreported usage and unknown resumed baseline do not invent totals', () => {
  assert.equal(summarizeSession(task, {runId:'empty', startedAt:100, events:[]}).reported, false);
  const report = summarizeSession(task, {runId:'resumed', startedAt:100, events:[
    {type:'usage', at:110, usage:{...tokens(1000, 100), resumed:true}},
    {type:'usage', at:120, usage:{...tokens(1010, 102), resumed:true}},
  ]});
  assert.equal(report.baselineOnly, true);
  assert.equal(report.total, 12);
});

test('run detail excludes usage before and after its own occurrence in a reused provider session',()=>{
 const run={runId:'r',startedAt:200,finishedAt:300,events:[{type:'session',at:201,resumeId:'provider'}]};
 const rows=normalizeMetrics([100,250,400].map((at,index)=>({id:index,at,runId:'local:codex:provider',sessionId:'provider',harness:'codex',type:'usage',usage:{...tokens((index+1)*100,0),scope:'session'}})));
 const stats=summarizeSession(task,run,rows);
 assert.equal(stats.total,100);assert.equal(stats.chart.tokens,100);
});
