import { periodStart } from './metrics.js';

// Subagent statistics from normalized metric rows, the same for every agent:
// launch rows (type "subagent") come from the parent's transcript, and work
// rows tagged `subagent` come from each subagent's own transcript.

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function summarizeSubagents(rows, { harness = '', model = '', range = 'all' } = {}, now = Date.now() / 1000) {
  const from = periodStart(range, now) ?? -Infinity;
  const picked = rows.filter(row => row.at >= from && row.at <= now && (!harness || row.harness === harness)
    && (!model || (row.model || '__default__') === model));
  const total = picked.reduce((sum, row) => sum + (row.reported ? row.inputTokens + row.outputTokens : 0), 0);
  const types = new Map();
  const type = name => {
    if (!types.has(name)) types.set(name, { name, launches: 0, failed: 0, background: 0, tokens: 0, tools: 0, durations: [], models: new Set(), ids: new Set(), launchTokens: 0, spans: new Map() });
    return types.get(name);
  };
  for (const row of picked) {
    if (row.type === 'subagent') {
      const item = type(row.subagentType || 'subagent');
      item.launches += 1;
      if (row.status === 'failed') item.failed += 1;
      if (row.status === 'background') item.background += 1;
      if (Number.isFinite(row.durationMs)) item.durations.push(row.durationMs / 1000);
      if (Number.isFinite(row.tokens)) item.launchTokens += row.tokens;
      if (row.subagentModel) item.models.add(row.subagentModel);
    } else if (row.subagent) {
      const item = type(row.subagent);
      if (row.subagentId) {
        item.ids.add(row.subagentId);
        const span = item.spans.get(row.subagentId) || [row.at, row.at];
        item.spans.set(row.subagentId, [Math.min(span[0], row.at), Math.max(span[1], row.at)]);
      }
      if (row.reported) item.tokens += row.inputTokens + row.outputTokens;
      if (row.type === 'activity') item.tools += 1;
      if (row.model && row.type === 'usage') item.models.add(row.model);
    }
  }
  const list = [...types.values()].map(item => {
    // Transcripts give run times for background subagents too; the launch result is the fallback.
    const spans = [...item.spans.values()].map(([start, end]) => end - start).filter(seconds => seconds > 0);
    const durations = spans.length ? spans : item.durations;
    return {
      name: item.name,
      launches: Math.max(item.launches, item.ids.size),
      failed: item.failed,
      tokens: item.tokens || item.launchTokens,
      tools: item.tools,
      typicalSeconds: median(durations),
      longestSeconds: durations.length ? Math.max(...durations) : null,
      models: [...item.models].sort(),
    };
  }).sort((a, b) => b.launches - a.launches || b.tokens - a.tokens);
  const launches = list.reduce((sum, item) => sum + item.launches, 0);
  const tokens = list.reduce((sum, item) => sum + item.tokens, 0);
  const failed = list.reduce((sum, item) => sum + item.failed, 0);
  const allDurations = [...types.values()].flatMap(item => { const spans = [...item.spans.values()].map(([a, b]) => b - a).filter(s => s > 0); return spans.length ? spans : item.durations; });
  return {
    launches, tokens, failed, types: list,
    share: total ? Math.min(1, tokens / total) : null,
    typicalSeconds: median(allDurations),
    longestSeconds: allDurations.length ? Math.max(...allDurations) : null,
  };
}

export function formatSeconds(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.round(seconds % 3600 / 60)).padStart(2, '0')}m`;
}
