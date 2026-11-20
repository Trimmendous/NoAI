import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionTokens, contextPercent } from '../src/js/components/sessions.js';
import { normalizeMetrics, summarizeMetrics, outcomeTotals } from '../src/js/core/metrics.js';

test('session tokens add cache reads, cache writes, output and subagents', () => {
  const session = {tokens:{input:10, cacheRead:1000, cacheWrite:200, output:40}, subagents:{count:2, tokens:{input:5, cacheRead:0, cacheWrite:0, output:5}}};
  assert.deepEqual(sessionTokens(session), {own:1250, subagents:10, subagentCount:2, total:1260});
  assert.equal(sessionTokens({}), null);
});

test('context fill is a percentage of the window and unknown without both numbers', () => {
  assert.equal(contextPercent({context:{used:50_000, window:200_000}}), 25);
  assert.equal(contextPercent({context:{used:300_000, window:200_000}}), 100);
  assert.equal(contextPercent({context:{used:10}}), null);
  assert.equal(contextPercent({}), null);
});

test('outcomes count responses, working tools and each kind of error per bucket', () => {
  const now = Date.UTC(2026, 10, 19, 12)/1000;
  const base = {harness:'claude', model:'m', sessionId:'s', runId:'local:claude:s', source:'local'};
  const rows = normalizeMetrics([
    {...base, id:'u1', at:now-600, type:'usage', usage:{kind:'tokens', scope:'turn', inputTokens:10, outputTokens:2, cacheReadTokens:0}},
    {...base, id:'o1', at:now-500, type:'outcome', outcome:'tool_ok'},
    {...base, id:'o2', at:now-400, type:'outcome', outcome:'tool_error'},
    {...base, id:'o3', at:now-300, type:'outcome', outcome:'connection_error'},
    {...base, id:'o4', at:now-200, type:'outcome', outcome:'rate_limit'},
  ]);
  const report = summarizeMetrics(rows, {range:'24h'}, now);
  assert.deepEqual(report.outcomes, {responses:1, toolOk:1, toolError:1, connection:1, rateLimit:1, apiError:0});
  assert.equal(report.points.reduce((sum, point) => sum + point.connection, 0), 1);
  assert.deepEqual(outcomeTotals(report.outcomes), {ok:2, errors:3, rate:0.4});
});
