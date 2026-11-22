import { element } from './dom.js';
import { icon } from './ui.js';
import { renderUsageChart } from './usage-chart.js';
import { renderOutcomesChart } from './outcomes-chart.js';
import { summarizeMetrics, outcomeTotals } from '../core/metrics.js';
import { getHarness } from '../core/catalog.js';

// The Dashboard's charts and numbers for one job or one session: the same
// tiles, usage chart, calls-and-errors chart, tools and models, drawn from
// only that item's records. Controls are remembered per container.

const compact = value => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const number = value => value.toLocaleString();

function select(options, value, label, onChange) {
  const wrap = element('label');
  wrap.append(element('span', 'sr-only', label));
  const node = element('select', 'ui-popup');
  for (const [key, text] of options) node.append(new Option(text, key));
  node.value = value;
  node.addEventListener('change', () => onChange(node.value));
  wrap.append(node);
  return wrap;
}

function stat(label, value, note, kind, color) {
  const card = element('div', 'ui-filter ui-stat metrics-stat');
  card.style.setProperty('--filter', color);
  const top = element('span', 'ui-filter-top'), mark = element('span', 'ui-filter-icon');
  mark.append(icon(kind));
  top.append(mark, element('strong', 'metrics-stat-value', value));
  card.append(top, element('span', 'ui-filter-label metric-label', label), element('small', '', note));
  return card;
}

/** Draws analytics for `rows` (normalized metric records) into `container`. */
export function renderItemAnalytics(container, rows, { what = 'this item' } = {}) {
  const settings = container._analytics ||= { range: 'all', metric: 'total', style: 'bar', outcomes: 'bar' };
  const redraw = () => renderItemAnalytics(container, rows, { what });
  container.classList.add('item-analytics');
  if (!rows.length) {
    container.replaceChildren(element('h3', 'item-analytics-title', 'Usage'), element('p', 'metrics-empty', `No usage recorded for ${what} yet. Charts appear once its agent reports tokens or tool calls.`));
    return;
  }
  const report = summarizeMetrics(rows, { range: settings.range });
  const outcomes = outcomeTotals(report.outcomes);

  const head = element('div', 'metrics-figure-head');
  const controls = element('div', 'metrics-figure-controls');
  controls.append(select([['24h', '24 hours'], ['7d', '1 week'], ['30d', '30 days'], ['all', 'All time']], settings.range, 'Time frame', value => { settings.range = value; redraw(); }));
  head.append(element('h3', 'item-analytics-title', 'Usage'), controls);

  // Nothing in this time frame: one line instead of empty charts.
  if (!report.usageReports && !report.toolCount && !(outcomes.ok + outcomes.errors)) {
    container.replaceChildren(head, element('p', 'metrics-empty', settings.range === 'all' ? `No usage recorded for ${what} yet. Charts appear once its agent reports tokens or tool calls.` : 'Nothing recorded in this time frame. Try a longer one.'));
    return;
  }
  const tiles = element('div', 'metrics-totals item-analytics-tiles');
  tiles.append(
    stat('Tokens', report.usageReports ? compact(report.tokens) : '—', report.usageReports ? `${compact(report.input)} in · ${compact(report.output)} out` : 'Not reported', 'bolt', 'var(--tile-home)'),
    stat('Cache hits', report.cacheRate === null ? '—' : `${(report.cacheRate * 100).toFixed(1)}%`, 'Cached reads ÷ all input', 'stack', 'var(--tile-chat)'),
    stat('Cost', report.cost === null ? '—' : `$${report.cost.toLocaleString(undefined, { maximumFractionDigits: 2 })}`, report.cost === null ? 'Not reported by the agent' : 'Recorded by the agent · USD', 'coin', 'var(--tile-accounts)'),
    stat('Success rate', outcomes.rate === null ? '—' : `${(outcomes.rate * 100).toFixed(1)}%`, `${number(outcomes.ok)} worked · ${number(outcomes.errors)} failed`, 'done', 'var(--tile-jobs)'),
  );

  const usage = element('figure', 'metrics-figure');
  const usageHead = element('div', 'metrics-figure-head');
  const usageControls = element('div', 'metrics-figure-controls');
  usageControls.append(
    select([['total', 'Tokens'], ['cost', 'Cost (USD)'], ['tools', 'Tool events']], settings.metric, 'Show', value => { settings.metric = value; redraw(); }),
    select([['bar', 'Bar graph'], ['line', 'Line graph']], settings.style, 'Chart type', value => { settings.style = value; redraw(); }),
  );
  usageHead.append(element('h4', '', 'Usage over time'), usageControls);
  const usageChart = element('div');
  renderUsageChart(usageChart, report, { metric: settings.metric, style: settings.style });
  usage.append(usageHead, usageChart);

  const calls = element('figure', 'metrics-figure metrics-outcomes-figure');
  const callsHead = element('div', 'metrics-figure-head');
  const callsControls = element('div', 'metrics-figure-controls');
  callsControls.append(select([['bar', 'Bar graph'], ['line', 'Line graph']], settings.outcomes, 'Calls and errors chart type', value => { settings.outcomes = value; redraw(); }));
  callsHead.append(element('h4', '', 'Calls and errors'), callsControls);
  const callsChart = element('div');
  renderOutcomesChart(callsChart, report, { style: settings.outcomes });
  calls.append(callsHead, callsChart);

  const breakdown = element('div', 'item-analytics-breakdown');
  const tools = element('section', 'metrics-tools-section');
  tools.append(element('h4', '', 'Tools used'));
  const toolList = element('div', 'metrics-tools');
  if (!report.tools.length) toolList.append(element('p', 'metrics-empty', 'No tool calls in this time frame.'));
  for (const tool of report.tools.slice(0, 8)) {
    const row = element('div', 'metrics-tool'), label = element('div', 'metrics-tool-label');
    label.append(element('span', '', tool.name), element('strong', '', number(tool.count)));
    const meter = element('meter', 'metrics-tool-meter');
    meter.min = 0; meter.max = Math.max(1, report.toolCount); meter.value = tool.count;
    meter.setAttribute('aria-label', `${tool.name}: ${tool.count} calls`);
    row.append(label, meter); toolList.append(row);
  }
  tools.append(toolList);
  const models = element('section', 'item-analytics-models');
  models.append(element('h4', '', 'Models'));
  const list = element('div', 'ui-list');
  for (const group of report.groups) {
    const row = element('div', 'ui-row no-leading');
    const copy = element('span', 'ui-row-copy');
    copy.append(element('span', 'ui-row-title', group.model || 'Default model'), element('span', 'ui-row-subtitle', getHarness(group.harness)?.label || group.harness));
    const end = element('span', 'ui-row-trailing', group.reported ? `${compact(group.tokens)} tokens` : 'Not reported');
    row.append(copy, end); list.append(row);
  }
  if (!report.groups.length) list.append(element('p', 'ui-list-empty', 'No model usage in this time frame.'));
  models.append(list);
  breakdown.append(tools, models);

  container.replaceChildren(head, tiles, usage, calls, breakdown);
}
