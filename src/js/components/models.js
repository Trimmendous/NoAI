import { element } from './dom.js';
import { getHarness } from '../core/catalog.js';
import { normalizeMetrics } from '../core/metrics.js';
import { agentColor, agentLogo, agentTile, filterTiles, group, pill, row } from './ui.js';

// Models tab: every agent on this computer and the models it can use, from
// what the CLI lists, the user's CLI settings, local history and IDs typed into
// Noai. Nothing is hardcoded. The
// selected agent sits in the middle of a graph with its models around it;
// lines are thicker for models that have been used in the last 30 days.

const $ = selector => document.querySelector(selector);
const NS = 'http://www.w3.org/2000/svg';
const MONTH = 30 * 86400;
const compact = value => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Positions on one or two ellipses around the centre, starting at the top. */
export function layoutNodes(count, { cx, cy, rx, ry }) {
  const twoRings = count > 10;
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / count;
    const scale = twoRings && index % 2 ? .68 : 1;
    return { x: cx + Math.cos(angle) * rx * scale, y: cy + Math.sin(angle) * ry * scale };
  });
}

function renderGraph(agent, models, usage) {
  const width = 760, height = models.length > 10 ? 460 : 400, cx = width / 2, cy = height / 2;
  const color = agentColor(agent.id);
  const max = Math.max(1, ...models.map(model => usage.get(model.id) || 0));
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'model-graph', role: 'img', 'aria-label': `${agent.label} can use ${models.length} model${models.length === 1 ? '' : 's'}: ${models.map(model => model.label).join(', ')}` });
  root.style.setProperty('--agent', color);
  const links = svg('g', { class: 'model-links' }), nodes = svg('g', { class: 'model-nodes' });
  const points = layoutNodes(models.length, { cx, cy, rx: width / 2 - 100, ry: height / 2 - 40 });
  models.forEach((model, index) => {
    const { x, y } = points[index];
    const used = usage.get(model.id) || 0;
    // A gentle curve, bowed away from the centre line.
    const mx = (cx + x) / 2 + (y - cy) * .12, my = (cy + y) / 2 - (x - cx) * .12;
    links.append(svg('path', { d: `M${cx},${cy} Q${mx},${my} ${x},${y}`, class: `model-link${used ? ' is-used' : ''}`, 'stroke-width': used ? 1.5 + 3 * Math.sqrt(used / max) : 1.25 }));
    const label = model.label || model.id;
    const shown = label.length > 26 ? `${label.slice(0, 25)}…` : label, usageText = used ? compact(used) : '';
    const w = Math.max(84, shown.length * 7.4 + 38 + (used ? usageText.length * 6.8 + 10 : 0)), h = 32;
    const node = svg('g', { class: `model-node${used ? ' is-used' : ''}${model.source === 'agent' ? '' : ' is-custom'}`, transform: `translate(${x - w / 2} ${y - h / 2})` });
    node.append(svg('title', {}, `${label} (${model.id})${used ? ` · ${compact(used)} tokens in 30 days` : ''}`));
    node.append(svg('rect', { width: w, height: h, rx: h / 2, class: 'model-node-bg' }));
    node.append(svg('circle', { cx: 15, cy: h / 2, r: 4.5, class: 'model-node-dot' }));
    node.append(svg('text', { x: 26, y: h / 2, class: 'model-node-label' }, shown));
    if (used) node.append(svg('text', { x: w - 13, y: h / 2, class: 'model-node-usage', 'text-anchor': 'end' }, usageText));
    nodes.append(node);
  });
  const centre = svg('g', { class: 'model-centre' });
  centre.append(svg('circle', { cx, cy, r: 58, class: 'model-centre-halo' }), svg('circle', { cx, cy, r: 44, class: 'model-centre-disc' }));
  centre.append(svg('text', { x: cx, y: cy - 3, class: 'model-centre-letter' }, agent.label.slice(0, 1).toUpperCase()));
  centre.append(svg('text', { x: cx, y: cy + 19, class: 'model-centre-label' }, agent.label));
  root.append(links, nodes, centre);
  // With a logo file, the centre shows the logo on a white disc instead of the letter.
  void agentLogo(agent.id).then(logo => {
    if (!logo) return;
    centre.classList.add('has-logo');
    centre.querySelector('.model-centre-letter')?.remove();
    centre.append(svg('image', { href: logo.url, x: cx - 20, y: cy - 30, width: 40, height: 40, class: `model-centre-logo${logo.mono ? ' is-mono' : ''}` }));
  });
  return root;
}

export function initModels({ getRuntime, getModels, getCustomModels, fetchMetrics, native }) {
  const view = $('#models-content');
  const cache = new Map();
  let usage = new Map(), seen = new Map(), selected = '', loading = null;

  const installed = () => (getRuntime()?.harnesses || []).filter(item => item.installed);

  async function refresh(force = false) {
    if (!native) { render(); return; }
    if (loading) return loading;
    $('#models-refresh').disabled = true;
    $('#models-status').textContent = 'Looking for models…';
    loading = (async () => {
      if (force) cache.clear();
      await Promise.all(installed().map(async agent => {
        if (cache.has(agent.id)) return;
        try {
          const found = await getModels(agent.id);
          cache.set(agent.id, (Array.isArray(found) ? found : []).map(item => typeof item === 'string' ? { id: item, label: item, source: 'agent' } : { id: item.id, label: item.label || item.id, source: item.source || 'agent' }));
        } catch { cache.set(agent.id, []); }
      }));
      try {
        const since = Date.now() / 1000 - MONTH;
        const rows = normalizeMetrics((await fetchMetrics())?.records || []);
        usage = new Map(); seen = new Map();
        for (const item of rows) {
          // Every model that ever answered counts as available, custom ones included.
          if (item.model && !item.model.startsWith('<') && item.harness !== 'unknown') {
            if (!seen.has(item.harness)) seen.set(item.harness, new Set());
            seen.get(item.harness).add(item.model);
          }
          if (!item.reported || item.at < since) continue;
          const key = `${item.harness}:${item.model}`;
          usage.set(key, (usage.get(key) || 0) + item.inputTokens + item.outputTokens);
        }
      } catch { usage = new Map(); }
      $('#models-status').textContent = '';
      render();
    })().finally(() => { loading = null; $('#models-refresh').disabled = false; });
    return loading;
  }

  // The agent's own list and its settings (from the backend), then models
  // seen in local history, then IDs typed into Noai. No presets anywhere.
  function modelsFor(agentId) {
    const models = [...(cache.get(agentId) || [])];
    const add = (id, source) => { if (id && !models.some(model => model.id === id)) models.push({ id, label: id, source, custom: source === 'noai' }); };
    for (const id of seen.get(agentId) || []) add(id, 'history');
    for (const id of getCustomModels()?.[agentId] || []) add(id, 'noai');
    return models;
  }

  function render() {
    const agents = installed();
    const missing = (getRuntime()?.harnesses || []).filter(item => !item.installed);
    if (!native || !agents.length) {
      const empty = element('div', 'scheduled-empty-state');
      empty.append(element('h3', '', native ? 'No agents found' : 'Open the desktop app'), element('p', '', native ? 'Install Claude Code, Codex or another supported agent CLI and sign in, then refresh.' : 'Models are read from the agents installed on this computer.'));
      view.replaceChildren(empty);
      return;
    }
    if (!agents.some(agent => agent.id === selected)) selected = agents[0].id;
    const fragment = document.createDocumentFragment();
    fragment.append(filterTiles(agents.map(agent => ({ id: agent.id, label: getHarness(agent.id)?.label || agent.label || agent.id, count: modelsFor(agent.id).length, icon: (agent.label || agent.id).slice(0, 1).toUpperCase(), color: agentColor(agent.id), agent: agent.id })), selected, id => { selected = id; render(); }, 'models-agents'));

    const agent = agents.find(item => item.id === selected);
    const label = getHarness(agent.id)?.label || agent.label || agent.id;
    const models = modelsFor(agent.id);
    const usageFor = new Map(models.map(model => [model.id, usage.get(`${agent.id}:${model.id}`) || 0]));
    const card = element('figure', 'model-graph-card');
    card.style.setProperty('--agent', agentColor(agent.id));
    if (models.length) card.append(renderGraph({ id: agent.id, label }, models, usageFor));
    else card.append(element('p', 'ui-list-empty', loading ? 'Looking for models…' : `${label} didn’t list any models, none are set in its settings, and none appear in your history yet. You can still type a model ID when starting a chat or job.`));
    const caption = element('figcaption', 'model-graph-caption');
    caption.append(element('span', 'model-key is-used', 'Used in the last 30 days'), element('span', 'model-key', 'Available'), element('span', 'model-key is-custom', 'From your settings or history'));
    if (models.length) card.append(caption);
    fragment.append(card);

    const rows = [...models].sort((a, b) => (usageFor.get(b.id) || 0) - (usageFor.get(a.id) || 0)).map(model => {
      const used = usageFor.get(model.id) || 0;
      const from = { agent: `Listed by ${label}`, settings: `From your ${label} settings`, history: 'Seen in your history', noai: 'Added by you in Noai' }[model.source] || '';
      return row({
        title: model.label || model.id,
        subtitle: [model.label && model.label !== model.id ? model.id : '', from].filter(Boolean).join(' · '),
        trailing: [used ? `${compact(used)} tokens · 30 days` : pill('Not used lately')],
      });
    });
    if (rows.length) fragment.append(group(`${label} models`, rows));
    const details = [agent.version ? `Version ${agent.version}` : '', agent.path || ''].filter(Boolean).join(' · ');
    if (details) fragment.append(element('p', 'ui-footnote', details));
    if (missing.length) {
      fragment.append(group('Not installed', missing.map(item => row({ leading: agentTile(item.id, getHarness(item.id)?.label || item.label, 'is-muted'), title: getHarness(item.id)?.label || item.label || item.id, subtitle: 'Install and sign in to its CLI to use it in Noai', trailing: [pill('Not found')] }))));
    }
    view.replaceChildren(fragment);
  }

  $('#models-refresh').addEventListener('click', () => void refresh(true));
  return { refresh, render };
}
