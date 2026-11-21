import { element } from './dom.js';

// Shared Apple-style building blocks: icon tiles, grouped lists of rows,
// Reminders-style filter tiles and gauge rings. Styled in styles/ui.css.

const NS = 'http://www.w3.org/2000/svg';
export const ICONS = {
  chevron: ['M9 6l6 6-6 6'],
  clock: ['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  repeat: ['M17 2l4 4-4 4', 'M3 11V9a3 3 0 0 1 3-3h15', 'M7 22l-4-4 4-4', 'M21 13v2a3 3 0 0 1-3 3H3'],
  done: ['M5 12.5l4.5 4.5L19 7.5'],
  alert: ['M12 8v5', 'M12 16.5v.01', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  chat: ['M5 5.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 3v-14a2 2 0 0 1 2-2z'],
  stack: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5'],
  cpu: ['M7 7h10v10H7z', 'M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4'],
  bolt: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  coin: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M14.5 9a2.5 2 0 0 0-2.5-1.5c-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2A2.5 2 0 0 1 9.5 15', 'M12 6v1.5M12 16.5V18'],
  people: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.5a3.5 3.5 0 0 1 0 6.5', 'M18 14a6.5 6.5 0 0 1 3.5 6'],
  doc: ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6M10 17h4'],
  person: ['M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M5 21a7 7 0 0 1 14 0'],
  key: ['M15 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'M10.5 13.5 3 21M6 18l2 2'],
};

export function icon(kind, className = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  for (const d of ICONS[kind] || ICONS.stack) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** A rounded colour tile holding an icon, or a letter when `kind` is a single character. */
export function tile(kind, color, className = '') {
  const node = element('span', `ui-tile${className ? ` ${className}` : ''}`);
  node.setAttribute('aria-hidden', 'true');
  if (color) node.style.setProperty('--tile', color);
  if (kind.length === 1) node.append(element('b', '', kind));
  else node.append(icon(kind));
  return node;
}

// Optional agent logos: src/logos/<agent id>.svg (or .png). Each agent is
// checked once; without a file it keeps its coloured letter tile.
const logos = new Map();
function probe(url) {
  return new Promise(resolve => {
    const image = new Image();
    image.addEventListener('load', () => resolve(true));
    image.addEventListener('error', () => resolve(false));
    image.src = url;
  });
}

/**
 * True when an SVG draws only in black (explicitly or by default), so dark
 * themes can show it in white instead of letting it vanish.
 */
export function isMonochromeSvg(text) {
  if (/<(linearGradient|radialGradient|image)\b/i.test(text)) return false;
  const colors = [...text.matchAll(/(?:fill|stroke|stop-color)\s*[=:]\s*["']?\s*([^"';\s>]+)/gi)].map(match => match[1].toLowerCase());
  return colors.every(color => ['#000', '#000000', 'black', 'none', 'currentcolor', 'transparent'].includes(color));
}

/** Resolves to { url, mono } for the agent's logo, or null when there is none. */
export function agentLogo(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id || '')) return Promise.resolve(null);
  if (!logos.has(id)) logos.set(id, (async () => {
    const svg = `logos/${id}.svg`;
    try {
      const response = await fetch(svg);
      if (response.ok) return { url: svg, mono: isMonochromeSvg(await response.text()) };
    } catch { /* fall through to PNG */ }
    const png = `logos/${id}.png`;
    return await probe(png) ? { url: png, mono: false } : null;
  })());
  return logos.get(id);
}

/** Swaps a tile's letter for the agent's logo once it is known to exist. */
export function applyLogo(node, id) {
  node.style.setProperty('--logo-tint', agentColor(id));
  void agentLogo(id).then(logo => {
    if (!logo) return;
    const image = element('img', `agent-logo${logo.mono ? ' is-mono' : ''}`);
    image.src = logo.url;
    image.alt = '';
    node.replaceChildren(image);
    node.classList.add('has-logo');
  });
  return node;
}

/** Fixed colour per agent so a harness looks the same on every page. */
const AGENTS = new Set(['claude', 'codex', 'gemini', 'copilot', 'cursor', 'openrouter', 'noai']);
export function agentColor(id) {
  return AGENTS.has(id) ? `var(--agent-${id})` : 'var(--tile-settings)';
}
export function agentTile(id, label, className = '') {
  return applyLogo(tile(String(label || id || '?').slice(0, 1).toUpperCase(), agentColor(id), className), id);
}

/**
 * One row of a grouped list. `trailing` is an array of nodes or strings.
 * With `onClick` the row is a button and gets a chevron.
 */
export function row({ leading, title, subtitle, trailing = [], onClick, className = '' }) {
  const node = element(onClick ? 'button' : 'div', `ui-row${onClick ? ' is-link' : ''}${className ? ` ${className}` : ''}`);
  if (onClick) { node.type = 'button'; node.addEventListener('click', onClick); }
  const copy = element('span', 'ui-row-copy');
  copy.append(element('span', 'ui-row-title', title));
  if (subtitle) copy.append(element('span', 'ui-row-subtitle', subtitle));
  const end = element('span', 'ui-row-trailing');
  for (const item of trailing) if (item) end.append(typeof item === 'string' ? element('span', '', item) : item);
  if (onClick) end.append(icon('chevron', 'ui-chevron'));
  node.append(...(leading ? [leading] : []), copy, end);
  if (!leading) node.classList.add('no-leading');
  return node;
}

/** A titled group: small heading above one rounded list. */
export function group(title, rows, label = title) {
  const section = element('section', 'ui-group');
  if (label) section.setAttribute('aria-label', label);
  if (title) section.append(element('h3', 'ui-group-title', title));
  const list = element('div', 'ui-list');
  list.append(...rows);
  section.append(list);
  return section;
}

/** Reminders-style smart filters: `items` are { id, label, count, icon, color, agent? }. */
export function filterTiles(items, selected, onSelect, className = '') {
  const wrap = element('div', `ui-tiles${className ? ` ${className}` : ''}`);
  wrap.style.setProperty('--columns', String(Math.min(items.length, 4)));
  for (const item of items) {
    const button = element('button', `ui-filter${item.id === selected ? ' is-selected' : ''}`);
    button.type = 'button';
    button.dataset.filter = item.id;
    button.style.setProperty('--filter', item.color);
    button.setAttribute('aria-pressed', String(item.id === selected));
    const top = element('span', 'ui-filter-top');
    const mark = element('span', 'ui-filter-icon');
    mark.append(item.icon.length === 1 ? element('b', '', item.icon) : icon(item.icon));
    if (item.agent) applyLogo(mark, item.agent);
    top.append(mark, element('strong', '', String(item.count)));
    button.append(top, element('span', 'ui-filter-label', item.label));
    button.addEventListener('click', () => onSelect(item.id));
    wrap.append(button);
  }
  return wrap;
}

/** A small status pill. `tone` is one of good, warn, bad, accent or muted. */
export function pill(text, tone = 'muted') {
  return element('span', `ui-pill is-${tone}`, text);
}

/**
 * Activity-style ring gauge for a percentage (0–100). With `remaining`, the
 * ring is what's left, like a battery: it turns orange then red as it empties.
 */
export function ring(percent, { size = 56, stroke = 7, label = '', remaining = false } = {}) {
  const value = Math.max(0, Math.min(100, percent));
  const level = remaining ? (value <= 10 ? ' is-bad' : value <= 25 ? ' is-warn' : '') : (value >= 90 ? ' is-bad' : value >= 75 ? ' is-warn' : '');
  const radius = (size - stroke) / 2, circumference = 2 * Math.PI * radius;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', `ui-ring${level}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label || `${Math.round(value)}%`);
  for (const [className, dash] of [['ui-ring-track', ''], ['ui-ring-value', `${circumference * value / 100} ${circumference}`]]) {
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', size / 2); circle.setAttribute('cy', size / 2); circle.setAttribute('r', radius);
    circle.setAttribute('class', className);
    circle.setAttribute('stroke-width', stroke);
    if (dash) { circle.setAttribute('stroke-dasharray', dash); circle.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`); }
    svg.append(circle);
  }
  const text = document.createElementNS(NS, 'text');
  text.setAttribute('x', size / 2); text.setAttribute('y', size / 2);
  text.setAttribute('class', 'ui-ring-text');
  text.textContent = `${Math.round(value)}%`;
  svg.append(text);
  if (remaining) {
    text.setAttribute('y', size / 2 - 4);
    const note = document.createElementNS(NS, 'text');
    note.setAttribute('x', size / 2); note.setAttribute('y', size / 2 + 9);
    note.setAttribute('class', 'ui-ring-note');
    note.textContent = 'left';
    svg.append(note);
  }
  return svg;
}

/** "2h ago", "Yesterday", "Nov 3". */
export function relativeTime(seconds, now = Date.now() / 1000) {
  if (!Number.isFinite(seconds)) return '';
  const diff = now - seconds;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return 'Yesterday';
  const date = new Date(seconds * 1000);
  if (diff < 604800) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
