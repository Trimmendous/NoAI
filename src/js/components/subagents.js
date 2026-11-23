import { element } from './dom.js';
import { icon } from './ui.js';
import { summarizeSubagents, formatSeconds } from '../core/subagents.js';

// Subagent stats for the Dashboard, a job or a session: four tiles and a
// breakdown by subagent type. Works the same for every agent.

const compact = value => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

function tile(label, value, note, kind, color) {
  const card = element('div', 'ui-filter ui-stat metrics-stat');
  card.style.setProperty('--filter', color);
  const top = element('span', 'ui-filter-top'), mark = element('span', 'ui-filter-icon');
  mark.append(icon(kind));
  top.append(mark, element('strong', 'metrics-stat-value', value));
  card.append(top, element('span', 'ui-filter-label metric-label', label), element('small', '', note));
  return card;
}

export function renderSubagents(container, rows, filters = {}, { heading = 'h3', what = 'this selection' } = {}) {
  const report = summarizeSubagents(rows, filters);
  const title = element(heading, 'subagents-title', 'Subagents');
  if (!report.launches) {
    container.replaceChildren(title, element('p', 'metrics-empty', `No subagents in ${what}. When an agent hands part of its work to a helper agent, it shows up here.`));
    return report;
  }
  const done = report.launches - report.failed;
  const tiles = element('div', 'metrics-totals subagents-tiles');
  tiles.append(
    tile('Launched', report.launches.toLocaleString(), `${report.types.length} type${report.types.length === 1 ? '' : 's'}`, 'chat', 'var(--tile-models)'),
    tile('Share of tokens', report.share == null ? '—' : `${(report.share * 100).toFixed(1)}%`, report.tokens ? `${compact(report.tokens)} tokens by subagents` : 'Not reported', 'bolt', 'var(--tile-home)'),
    tile('Typical run', formatSeconds(report.typicalSeconds), report.longestSeconds ? `Longest ${formatSeconds(report.longestSeconds)}` : 'Run time not recorded', 'clock', 'var(--tile-jobs)'),
    tile('Finished', `${((done / report.launches) * 100).toFixed(0)}%`, `${report.failed} failed`, 'done', report.failed ? 'var(--tile-alert)' : 'var(--tile-chat)'),
  );
  const table = element('div', 'subagents-types');
  const most = Math.max(1, ...report.types.map(item => item.tokens));
  for (const item of report.types) {
    const row = element('div', 'subagents-type');
    const name = element('div', 'subagents-type-name');
    name.append(element('strong', '', item.name), element('span', '', item.models.join(', ') || 'Model not reported'));
    const meter = element('meter', 'metrics-tool-meter');
    meter.min = 0; meter.max = most; meter.value = item.tokens;
    meter.setAttribute('aria-label', `${item.name}: ${item.tokens} tokens`);
    const facts = element('div', 'subagents-type-facts');
    for (const [label, value] of [['Runs', item.launches.toLocaleString()], ['Tokens', item.tokens ? compact(item.tokens) : '—'], ['Typical', formatSeconds(item.typicalSeconds)], ['Tool calls', item.tools ? item.tools.toLocaleString() : '—'], ['Failed', item.failed.toLocaleString()]]) {
      const fact = element('span');
      fact.append(element('small', '', label), element('b', label === 'Failed' && item.failed ? 'is-bad' : '', value));
      facts.append(fact);
    }
    row.append(name, facts, meter);
    table.append(row);
  }
  container.replaceChildren(title, tiles, table);
  return report;
}
