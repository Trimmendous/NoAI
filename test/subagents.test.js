import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSubagents, formatSeconds } from '../src/js/core/subagents.js';

const base = { harness: 'claude', reported: false, inputTokens: 0, outputTokens: 0 };
const rows = [
  { ...base, type: 'usage', at: 100, reported: true, inputTokens: 800, outputTokens: 200 },
  { ...base, type: 'subagent', at: 100, subagentType: 'Explore', status: 'completed', durationMs: 30000, tokens: 500 },
  { ...base, type: 'subagent', at: 110, subagentType: 'Explore', status: 'failed' },
  { ...base, type: 'subagent', at: 120, subagentType: 'web-fetch', status: 'background', subagentModel: 'haiku' },
  { ...base, type: 'usage', at: 121, subagent: 'web-fetch', subagentId: 'a1', model: 'haiku', reported: true, inputTokens: 150, outputTokens: 50 },
  { ...base, type: 'activity', at: 181, subagent: 'web-fetch', subagentId: 'a1' },
];

test('subagents are summed by type, whatever agent launched them', () => {
  const report = summarizeSubagents(rows, {}, 1000);
  assert.equal(report.launches, 3);
  assert.equal(report.failed, 1);
  const explore = report.types.find(item => item.name === 'Explore');
  const fetch = report.types.find(item => item.name === 'web-fetch');
  assert.deepEqual([explore.launches, explore.tokens, explore.typicalSeconds], [2, 500, 30]);
  assert.deepEqual([fetch.tokens, fetch.tools, fetch.typicalSeconds, fetch.models], [200, 1, 60, ['haiku']]);
  assert.equal(report.share, 700 / 1200);
});

test('empty and formatting', () => {
  assert.equal(summarizeSubagents([], {}).launches, 0);
  assert.deepEqual([formatSeconds(42), formatSeconds(125), formatSeconds(3700)], ['42s', '2m 05s', '1h 02m']);
});
