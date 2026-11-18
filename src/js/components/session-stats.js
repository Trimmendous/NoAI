import { renderUsageChart } from './usage-chart.js';
import { element } from './dom.js';
import { normalizeMetrics, summarizeMetrics } from '../core/metrics.js';

export function summarizeSession(task, run, metrics = [], now = Date.now() / 1000) {
  const harness = run.harness || task.harness;
  const sessions = new Set((run.events || []).map(event => event.resumeId).filter(Boolean));
  for (const row of metrics) if (row.runId === run.runId && row.sessionId) sessions.add(row.sessionId);
  const matched = metrics.filter(row => (row.runId === run.runId || row.harness === harness && sessions.has(row.sessionId)) && (run.historyAvailable === false || row.at >= run.startedAt && row.at <= (run.finishedAt || now)));
  const saved = normalizeMetrics((run.events || []).map((event, index) => ({
    ...event, id: `${run.runId}:${event.eventId ?? index}`, runId: run.runId,
    harness, model: event.model || run.model || task.model || '', sessionId: event.resumeId,
    at: event.at || run.startedAt, tool: event.type === 'activity' ? event.text : undefined,
  })));
  // Prefer imported/recorded metrics per event type; never add them to the same saved events.
  const usage = (matched.some(row => row.type === 'usage') ? matched : saved).filter(row => row.type === 'usage');
  const activity = (matched.some(row => row.type === 'activity') ? matched : saved).filter(row => row.type === 'activity');
  const reports = usage.filter(row => row.reported);
  const models = new Map(), tools = new Map();
  let input = 0, output = 0, cached = 0;
  for (const row of reports) {
    input += row.inputTokens; output += row.outputTokens; cached += row.cacheReadTokens;
    const name = row.model || 'Not reported';
    const group = models.get(name) || { name, input: 0, output: 0, cached: 0 };
    group.input += row.inputTokens; group.output += row.outputTokens; group.cached += row.cacheReadTokens;
    models.set(name, group);
  }
  for (const row of activity) {
    const name = row.tool || 'Unnamed tool';
    tools.set(name, (tools.get(name) || 0) + 1);
  }
  const events = run.events || [];
  return {
    chart: summarizeMetrics([...usage,...activity],{range:'all'}, [...usage,...activity].reduce((at,row)=>Math.max(at,row.at),run.startedAt || now)),
    reported: reports.length > 0, reports: reports.length, baselineOnly: usage.some(row => row.baselineOnly),
    input, output, cached, total: input + output, tools: [...tools], toolCount: activity.length,
    models: [...models.values()], sessions: [...sessions],
    elapsed: Math.max(0, (run.finishedAt || now) - run.startedAt),
    resumes: run.resumeAttempts ?? events.filter(event => event.type === 'resumed').length,
    waits: events.filter(event => event.type === 'waiting').length,
    errors: events.filter(event => event.type === 'error').length,
  };
}

function duration(seconds) {
  if (!Number.isFinite(seconds)) return 'Not reported';
  const value = Math.floor(seconds);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;
}

export function renderSessionStats(container, task, run, metrics, note = '') {
  const stats = summarizeSession(task, run, metrics);
  const number = value => value.toLocaleString();
  const tokens = value => stats.reported ? number(value) : 'Not reported';
  const fragment = document.createDocumentFragment();
  fragment.append(element('h3', '', 'At a glance'));
  const grid = element('dl', 'session-stats-grid');
  const more = element('details', 'session-stats-more');
  more.open = container.querySelector('.session-stats-more')?.open || false;
  more.append(element('summary', '', 'More session stats'));
  const extra = element('dl', 'session-stats-grid');
  for (const [label, value] of [
    ['Total tokens', tokens(stats.total)], ['Input tokens', tokens(stats.input)],
    ['Output tokens', tokens(stats.output)], ['Cached input', tokens(stats.cached)],
    [run.elapsedLabel || 'Elapsed (including waits)', duration(stats.elapsed)], ['Tool events', number(stats.toolCount)],
    ['Resume attempts', run.historyAvailable === false ? 'Not reported' : number(stats.resumes)], ['Token waits', run.historyAvailable === false ? 'Not reported' : number(stats.waits)],
    ['Recorded errors', run.historyAvailable === false ? 'Not reported' : number(stats.errors)], ['Usage reports', number(stats.reports)], ['Cost', 'Not reported'],
  ]) {
    const cell = element('div'); cell.append(element('dt', '', label), element('dd', '', value));
    (['Total tokens', run.elapsedLabel || 'Elapsed (including waits)', 'Tool events'].includes(label) ? grid : extra).append(cell);
  }
  more.append(extra);
  fragment.append(grid);
  const figure=element('figure','metrics-figure');figure.append(element('h3','','Recorded token composition'));
  const chart=element('div');figure.append(chart);renderUsageChart(chart,stats.chart);
  if(stats.reported)fragment.append(figure);
  if(stats.tools.length) {
    const tools=element('div','detail-tools');tools.append(element('h3','','Most frequent tools'));
    for(const [name,count] of [...stats.tools].sort((a,b)=>b[1]-a[1]).slice(0,5)) {
      const row=element('div','metrics-tool');row.append(element('span','',`${name} · ${number(count)} events`));
      const meter=element('meter','metrics-tool-meter');meter.min=0;meter.max=stats.toolCount;meter.value=count;meter.setAttribute('aria-label',`${name}: ${count} of ${stats.toolCount} recorded tool events`);row.append(meter);tools.append(row);
    }
    fragment.append(tools);
  }
  fragment.append(more);
  more.append(element('p', 'scheduled-card-subtitle', 'Cached input is included in input tokens. Tool counts are recorded activity events.'));
  if (stats.baselineOnly) more.append(element('p', 'scheduled-card-subtitle', 'Partial usage: a resumed session had no earlier token reading; that first reading establishes a baseline.'));
  if (note) more.append(element('p', 'scheduled-card-subtitle', note));
  if (stats.models.length) {
    const wrapper = element('div', 'session-stats-table');
    const table = element('table');
    table.append(element('caption', '', 'Usage by model'));
    const head = element('thead'), header = element('tr');
    for (const label of ['Model', 'Input', 'Output', 'Cached']) { const th = element('th', '', label); th.scope = 'col'; header.append(th); }
    head.append(header); table.append(head);
    const body = element('tbody');
    for (const model of stats.models) {
      const row = element('tr');
      for (const value of [model.name, number(model.input), number(model.output), number(model.cached)]) row.append(element('td', '', value));
      body.append(row);
    }
    table.append(body); wrapper.append(table); more.append(wrapper);
  }
  if (stats.tools.length) {
    more.append(element('h5', '', 'Tool activity'));
    const list = element('dl', 'session-tool-list');
    for (const [name, count] of stats.tools) list.append(element('dt', '', name), element('dd', '', number(count)));
    more.append(list);
  }
  for (const session of stats.sessions) more.append(element('p', 'scheduled-card-subtitle', `Provider session: ${session}`));
  container.replaceChildren(fragment);
}
