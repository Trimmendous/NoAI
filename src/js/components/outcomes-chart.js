import { element } from './dom.js';
import { outcomeTotals } from '../core/metrics.js';

// One stacked column per time bucket: successful calls at the base, errors
// stacked on top. Errors are often a sliver, so any non-zero error segment is
// drawn at least MIN_SEGMENT px tall; exact counts are in the tooltip and table.
const MIN_SEGMENT = 3;
const ERRORS = [
  ['toolError', 'Tool failed', 'outcome-tool'],
  ['connection', 'Connection', 'outcome-connection'],
  ['apiError', 'API / rate limit', 'outcome-api'],
];
const errorValue = (point, key) => key === 'apiError' ? point.apiError + point.rateLimit : point[key];
const number = value => value.toLocaleString();
const compact = value => Intl.NumberFormat(undefined, {notation:'compact', maximumFractionDigits:1}).format(value);

function svgNode(tag, attrs = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
// A bar whose top corners are rounded and whose base sits flat on the baseline.
function bar(x, y, width, height, radius) {
  const r = Math.min(radius, width/2, height);
  return `M${x},${y+height}V${y+r}Q${x},${y} ${x+r},${y}H${x+width-r}Q${x+width},${y} ${x+width},${y+r}V${y+height}Z`;
}
function niceMax(value) {
  if (value <= 4) return Math.max(1, Math.ceil(value));
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map(step => step*power).find(step => step >= value);
}

export function renderOutcomesChart(container, report) {
  container.replaceChildren();
  const totals = report.outcomes, summary = outcomeTotals(totals);
  if (!summary.ok && !summary.errors) {
    container.append(element('p', 'metrics-empty', 'No calls recorded in this period.'));
    return;
  }
  const stats = element('div', 'outcome-stats');
  for (const [label, value, note, swatch] of [
    ['Success rate', summary.rate === null ? '—' : `${(summary.rate*100).toFixed(summary.rate > .999 || summary.rate < .99 ? 1 : 2)}%`, `${number(summary.ok)} successful · ${number(summary.errors)} failed`],
    ['Tool failures', number(totals.toolError), 'Commands or tools that failed on this computer', 'outcome-tool'],
    ['Connection errors', number(totals.connection), 'Could not reach the provider; retried', 'outcome-connection'],
    ['API / rate limit', number(totals.apiError + totals.rateLimit), `${number(totals.rateLimit)} rate-limited · ${number(totals.apiError)} other API errors`, 'outcome-api'],
  ]) {
    const card = element('div', 'metrics-stat'), name = element('span', 'metric-label');
    if (swatch) name.append(element('i', `swatch ${swatch}`));
    name.append(document.createTextNode(label));
    card.append(name, element('strong', 'metrics-stat-value', value), element('small', '', note));
    stats.append(card);
  }
  const legend = element('div', 'chart-legend');
  for (const [, label, className] of [['ok', 'Successful calls', 'outcome-ok'], ...ERRORS]) {
    const item = element('span'); item.append(element('i', `swatch ${className}`), document.createTextNode(label)); legend.append(item);
  }
  container.append(stats, legend);

  const points = report.points;
  const w = 760, left = 56, right = 16, top = 16, plot = 220, h = top + plot + 34, inner = w - left - right;
  const band = inner/points.length, width = Math.max(1, band*.72);
  const x = i => left + i*band + (band-width)/2;
  const total = point => point.responses + point.toolOk + ERRORS.reduce((sum, [key]) => sum + errorValue(point, key), 0);
  const max = niceMax(Math.max(...points.map(total)));
  const svg = svgNode('svg', {viewBox:`0 0 ${w} ${h}`, class:'metrics-chart outcomes-chart', role:'group', 'aria-label':'Successful calls with errors stacked on top, over time'});
  for (const tick of [0, max/2, max]) {
    if (max <= 1 && tick === max/2) continue;
    const y = top + plot - tick/max*plot;
    svg.append(svgNode('line', {x1:left, x2:w-right, y1:y, y2:y, class:tick ? 'chart-grid' : 'chart-axis'}),
      svgNode('text', {x:left-8, y:y+4, 'text-anchor':'end', class:'chart-label'}, compact(tick)));
  }
  const readout = element('p', 'chart-readout', 'Hover or focus a column for exact counts.');
  readout.setAttribute('aria-live', 'polite');
  const when = at => new Date(at*1000).toLocaleString(undefined, report.step === 3600 ? {month:'short', day:'numeric', hour:'numeric'} : {month:'short', day:'numeric', year:report.step > 86400 ? 'numeric' : undefined});
  points.forEach((point, i) => {
    const ok = point.responses + point.toolOk;
    const segments = [[ok, 'outcome-ok'], ...ERRORS.map(([key, , className]) => [errorValue(point, key), className])].filter(([value]) => value);
    let base = top + plot;
    segments.forEach(([value, className], index) => {
      const height = Math.max(className === 'outcome-ok' ? 1 : MIN_SEGMENT, value/max*plot);
      const last = index === segments.length - 1;
      // 2px surface gap between stacked segments; only the top segment is rounded.
      const gap = index ? 2 : 0, drawn = Math.max(1, height - gap), y = base - gap - drawn;
      svg.append(svgNode('path', {d:last ? bar(x(i), y, width, drawn, 3) : `M${x(i)},${y+drawn}V${y}H${x(i)+width}V${y+drawn}Z`, class:className}));
      base = y;
    });
    const errors = total(point) - ok;
    const label = `${when(point.at)}: ${number(ok)} successful (${number(point.responses)} model responses, ${number(point.toolOk)} tool calls) · ${number(errors)} errors: ${number(point.toolError)} tool failed, ${number(point.connection)} connection, ${number(point.apiError + point.rateLimit)} API / rate limit`;
    const hit = svgNode('rect', {x:left + i*band, y:top, width:band, height:plot, class:'chart-hit', tabindex:0, 'aria-label':label});
    hit.append(svgNode('title', {}, label));
    for (const type of ['mouseenter', 'focus']) hit.addEventListener(type, () => { readout.textContent = label; });
    svg.append(hit);
  });
  for (const i of new Set([0, Math.floor((points.length-1)/2), points.length-1])) {
    svg.append(svgNode('text', {x:x(i) + width/2, y:h-10, 'text-anchor':i === 0 ? 'start' : i === points.length-1 ? 'end' : 'middle', class:'chart-label'}, when(points[i].at)));
  }
  const details = element('details', 'chart-data'); details.append(element('summary', '', 'Exact counts'));
  const wrap = element('div', 'metrics-table-wrap'), table = element('table', 'metrics-table metrics-daily-table'), head = element('thead'), header = element('tr');
  for (const label of ['Bucket starts (local time)', 'Model responses', 'Tool calls OK', 'Tool failed', 'Connection', 'Rate limited', 'Other API errors']) { const th = element('th', '', label); th.scope = 'col'; header.append(th); }
  head.append(header); table.append(head);
  const body = element('tbody');
  for (const point of points) {
    const row = element('tr');
    for (const value of [new Date(point.at*1000).toLocaleString(), ...['responses', 'toolOk', 'toolError', 'connection', 'rateLimit', 'apiError'].map(key => number(point[key]))]) row.append(element('td', '', value));
    body.append(row);
  }
  table.append(body); wrap.append(table); details.append(wrap);
  container.append(svg, readout, details);
}
