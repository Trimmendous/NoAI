import { element } from './dom.js';
import { agentColor, agentLogo, agentTile } from './ui.js';

// Models tab, flock view: every installed agent flies as a V formation of its
// models, sized by tokens used in the last 30 days, with the agent's name
// flying ahead as a clickable label. Nothing here names an agent: the species comes
// from a hash of the agent's ID, the colour from agentColor and the badge from
// the agent's logo file, if it has one. Clicking a bird pauses the sky and
// shows its details.

const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 760;
const SIZE = 1.5; // every bird and gap, so flocks read at card width
const compact = value => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

// Wing outlines, drawn from the shoulder (0,0) sweeping up and back.
const pointed = w => `M0 0C${-w * .15} ${-w * .5} ${-w * .5} ${-w * .95} ${-w} ${-w * .9}C${-w * .6} ${-w * .55} ${-w * .35} ${-w * .1} 0 0Z`;
const rounded = w => `M0 0C0 ${-w * .8} ${-w * .7} ${-w * 1.1} ${-w} ${-w * .7}C${-w * .7} ${-w * .3} ${-w * .3} 0 0 0Z`;

/** Generic bird shapes, all facing right. Agents are mapped onto these by ID hash. */
export const SPECIES = Object.freeze([
  { name: 'goose', gap: 34, flap: .55, speed: 24, wing: pointed(22), shoulder: [2, -3], body: [16, 6], neck: [10, -2, 22, -7, 4], head: [23, -7, 3.6], beak: 'M26 -8.2L32 -6.6L26 -5.4Z', tail: 'M-14 -1L-23 -5L-22 3Z' },
  { name: 'swallow', gap: 26, flap: .17, speed: 44, wing: pointed(22), shoulder: [1, -2], body: [10, 3.5], head: [9, -1.5, 3], beak: 'M11.5 -2.2L15 -1.2L11.5 -.2Z', tail: 'M-8 -1L-25 -7L-13 0L-25 5L-8 1Z' },
  { name: 'crane', gap: 44, flap: .7, speed: 20, wing: pointed(27), shoulder: [1, -3], body: [13, 4.5], neck: [10, -1, 26, -3, 2.5], head: [27, -3, 2.7], beak: 'M29 -3.9L39 -2.8L29 -1.9Z', legs: 'M-12 0L-32 2M-12 1.5L-32 5' },
  { name: 'finch', gap: 20, flap: .11, speed: 34, wing: rounded(11), shoulder: [1, -3], body: [7.5, 5.2], head: [6.5, -3.5, 4], beak: 'M10 -4.8L14 -3L10 -1.4Z', tail: 'M-6 -1L-13 -3.5L-12 2.5Z' },
  { name: 'parrot', gap: 30, flap: .24, speed: 30, wing: pointed(16), shoulder: [1, -3], body: [11, 5], head: [10, -3.5, 4.6], beak: 'M14 -5Q19 -4.5 16.5 -.5L14 -2Z', tail: 'M-10 -1L-30 1.5L-10 2.5Z', crest: 'M7 -7L3 -14L9 -8.5L9.5 -15L12 -7.5Z' },
  { name: 'swift', gap: 24, flap: .14, speed: 50, wing: pointed(25), shoulder: [1, -1.5], body: [9, 3], head: [8, -1, 2.8], beak: 'M10.5 -1.6L13 -.8L10.5 0Z', tail: 'M-7 -.5L-17 -4L-11 0L-17 3L-7 .5Z' },
]);

/** Stable species for an agent ID (FNV-1a), so an agent always flies as the same bird. */
export function speciesFor(id) {
  let hash = 0x811c9dc5;
  for (const char of String(id)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return SPECIES[hash % SPECIES.length];
}

/** V formation: the first bird at the point (0,0), the rest alternating below and above, further back each rank. */
export function formation(count, gap) {
  return Array.from({ length: count }, (_, index) => {
    const rank = Math.ceil(index / 2), side = index % 2 ? 1 : -1;
    return { x: -rank * gap, y: side * rank * gap * .5 };
  });
}

/** Bird scale from 30-day tokens: unused models fly small, the busiest one largest. */
export function birdScale(used, max) {
  return used > 0 && max > 0 ? .85 + .45 * Math.sqrt(used / max) : .72;
}

function drawBird(species, { logo, delay }) {
  const bird = svg('g', { class: 'flock-bird-shape' });
  const flap = `${species.flap.toFixed(2)}s`;
  const wing = (fill, dx, dy) => {
    const holder = svg('g', { transform: `translate(${species.shoulder[0] + dx} ${species.shoulder[1] + dy})` });
    const path = svg('path', { d: species.wing, class: `flock-wing ${fill}` });
    path.style.animationDuration = flap;
    path.style.animationDelay = `-${delay.toFixed(2)}s`;
    holder.append(path);
    return holder;
  };
  const [hx, hy, hr] = species.head;
  bird.append(wing('is-far', 3, -1));
  if (species.legs) bird.append(svg('path', { d: species.legs, class: 'flock-legs' }));
  if (species.tail) bird.append(svg('path', { d: species.tail, class: 'flock-body' }));
  bird.append(svg('ellipse', { rx: species.body[0], ry: species.body[1], class: 'flock-body' }));
  if (species.neck) {
    const [x1, y1, x2, y2, width] = species.neck;
    bird.append(svg('path', { d: `M${x1} ${y1}L${x2} ${y2}`, class: 'flock-neck', 'stroke-width': width }));
  }
  if (species.crest) bird.append(svg('path', { d: species.crest, class: 'flock-body' }));
  bird.append(svg('circle', { cx: hx, cy: hy, r: hr, class: 'flock-body' }));
  bird.append(svg('path', { d: species.beak, class: 'flock-beak' }));
  bird.append(svg('circle', { cx: hx + hr * .35, cy: hy - hr * .25, r: .9, class: 'flock-eye' }));
  if (logo) {
    // The agent's logo printed on the body as a plain mark, sized to fit inside it.
    const [rx, ry] = species.body;
    const size = Math.min(ry * 2.1, rx * 1.1);
    bird.append(svg('image', { href: logo.url, x: -rx * .2 - size / 2, y: -size / 2 + ry * .1, width: size, height: size, class: 'flock-mark', filter: 'url(#flock-mark)' }));
  }
  bird.append(wing('is-near', 0, 0));
  return bird;
}

// Shared SVG filters: a bright outline around the selected bird's silhouette
// (with a thin dark edge so it reads on light and dark skies), and the logo
// mark recoloured to one flat colour so it shows on any agent's colour.
function filters() {
  const defs = svg('defs');
  // A soft halo in the theme's accent colour around the selected bird.
  const outline = svg('filter', { id: 'flock-outline', x: '-60%', y: '-60%', width: '220%', height: '220%' });
  outline.append(
    svg('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: 1.2, result: 'grown' }),
    svg('feGaussianBlur', { in: 'grown', stdDeviation: 2.4, result: 'soft' }),
    svg('feFlood', { class: 'flock-outline-glow', result: 'glowColour' }),
    svg('feComposite', { in: 'glowColour', in2: 'soft', operator: 'in', result: 'glow' }),
  );
  const merge = svg('feMerge');
  merge.append(svg('feMergeNode', { in: 'glow' }), svg('feMergeNode', { in: 'glow' }), svg('feMergeNode', { in: 'SourceGraphic' }));
  outline.append(merge);
  const mark = svg('filter', { id: 'flock-mark' });
  mark.append(svg('feFlood', { class: 'flock-mark-colour', result: 'colour' }), svg('feComposite', { in: 'colour', in2: 'SourceAlpha', operator: 'in' }));
  defs.append(outline, mark);
  return defs;
}

/**
 * Renders the sky. `flocks` is [{ agent: { id, label, version, path }, models: [{ id, label, source, used }] }],
 * already filtered to what this computer discovered. Returns the card element; its animation
 * stops on its own once the card leaves the document.
 */
export function renderFlocks(flocks, { reducedMotion = false, onChat = null } = {}) {
  const card = element('figure', 'flock-card');
  const sky = svg('svg', { class: 'flock-sky', role: 'group', 'aria-label': `${flocks.length} agent${flocks.length === 1 ? '' : 's'} flying with their models. Select a bird for details.` });
  const clouds = svg('g', { class: 'flock-clouds', 'aria-hidden': 'true' });
  const lanes = svg('g');
  sky.append(filters(), clouds, lanes);
  // The sky and a details card that floats beside the selected bird.
  const stage = element('div', 'flock-stage');
  const details = element('div', 'flock-details');
  details.hidden = true;
  details.setAttribute('role', 'dialog');
  details.setAttribute('aria-live', 'polite');
  const toolbar = element('div', 'flock-toolbar');
  const hint = element('span', 'flock-hint', 'Select a bird to pause and see its model.');
  const pauseButton = element('button', 'secondary-button flock-pause');
  pauseButton.type = 'button';
  toolbar.append(hint, pauseButton);

  let userPaused = reducedMotion, selected = null, t = 0, last = performance.now();
  const flying = [];
  let y = 24;

  flocks.forEach((flock, index) => {
    const { agent, models } = flock;
    const species = speciesFor(agent.id);
    const gap = species.gap * SIZE * (models.length > 12 ? .72 : 1);
    const spots = formation(models.length, gap);
    const ranks = Math.ceil((models.length - 1) / 2);
    const half = Math.max(44, ranks * gap * .5 + 28);
    const max = Math.max(0, ...models.map(model => model.used || 0));
    const ordered = [...models].sort((a, b) => (b.used || 0) - (a.used || 0));
    const lane = svg('g', { class: 'flock' });
    lane.style.setProperty('--agent', agentColor(agent.id));
    const birds = [];

    const clickable = (node, pick) => {
      const select = event => { event.stopPropagation(); choose({ node, lane, agent, models, ...pick }); };
      node.addEventListener('click', select);
      node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(event); } });
    };
    // Only models are birds; the busiest one flies at the point of the V.
    ordered.forEach((model, i) => {
      const name = model.label || model.id;
      const node = svg('g', { class: `flock-bird${model.used ? '' : ' is-idle'}`, tabindex: 0, role: 'button', 'aria-label': `${name} on ${agent.label}` });
      node.append(svg('title', {}, `${name}${model.used ? ` · ${compact(model.used)} tokens in 30 days` : ''}`));
      clickable(node, { model });
      lane.append(node);
      birds.push({ node, x: spots[i].x + (i ? Math.random() * 4 - 2 : 0), y: spots[i].y, scale: birdScale(model.used || 0, max), phase: Math.random() * 6, delay: Math.random() * species.flap });
    });
    // The agent is the label flying ahead of its flock; it opens the agent's details.
    const tag = svg('g', { class: 'flock-tag', tabindex: 0, role: 'button', 'aria-label': `${agent.label}, ${models.length} model${models.length === 1 ? '' : 's'}`, transform: 'translate(46 -26)' });
    const tagText = svg('text', { x: 0, y: 0, class: 'flock-label' }, `${agent.label} · ${models.length} model${models.length === 1 ? '' : 's'}`);
    tag.append(tagText);
    clickable(tag, { leader: true });
    lane.append(tag);
    lanes.append(lane);

    const span = ranks * gap + 60;
    flying.push({ lane, birds, agent, species, y: y + half, x: 80 + ((index * 233) % (WIDTH - 120)), span, phase: index * 1.7, hover: false });
    lane.addEventListener('pointerenter', () => { flying[index].hover = true; });
    lane.addEventListener('pointerleave', () => { flying[index].hover = false; });
    y += half * 2 + 8;

    void agentLogo(agent.id).then(logo => {
      for (const bird of birds) bird.node.append(drawBird(species, { logo, delay: bird.delay }));
      if (!logo) return;
      // In the label, the logo keeps its own colours, as on every other page.
      tag.prepend(svg('image', { href: logo.url, x: 0, y: -10, width: 12, height: 12, class: `flock-tag-logo${logo.mono ? ' is-mono' : ''}` }));
      tagText.setAttribute('x', 17);
    });
  });

  const height = Math.max(240, y + 16);
  sky.setAttribute('viewBox', `0 0 ${WIDTH} ${height}`);
  for (let i = 0; i < Math.max(3, Math.round(height / 110)); i++) {
    const cx = 60 + ((i * 271) % (WIDTH - 120)), cy = 30 + ((i * 137) % Math.max(1, height - 60));
    clouds.append(svg('ellipse', { cx, cy, rx: 70, ry: 13 }), svg('ellipse', { cx: cx + 36, cy: cy - 9, rx: 38, ry: 11 }));
  }

  function setPaused() {
    const still = userPaused || !!selected;
    sky.classList.toggle('is-paused', still);
    pauseButton.textContent = userPaused ? 'Play' : 'Pause';
    pauseButton.setAttribute('aria-pressed', String(userPaused));
  }

  function choose(pick) {
    if (selected?.node === pick.node) { clear(); return; }
    selected?.node.classList.remove('is-selected');
    selected = pick;
    pick.node.classList.add('is-selected');
    for (const flock of flying) flock.lane.classList.toggle('is-dimmed', flock.lane !== pick.lane);
    details.style.setProperty('--agent', agentColor(pick.agent.id));
    details.replaceChildren(...describe(pick));
    details.hidden = false;
    place(pick.node);
    hint.textContent = 'Paused. Select the bird again or press Escape to fly on.';
    setPaused();
  }

  function clear() {
    if (!selected) return;
    selected.node.classList.remove('is-selected');
    selected = null;
    for (const flock of flying) flock.lane.classList.remove('is-dimmed');
    details.hidden = true;
    details.replaceChildren();
    hint.textContent = 'Select a bird to pause and see its model.';
    setPaused();
  }

  // Beside the bird when there's room (right first, then left); below the sky on small windows.
  function place(node) {
    if (matchMedia('(max-width: 640px)').matches) { details.classList.add('is-docked'); return; }
    details.classList.remove('is-docked');
    const box = stage.getBoundingClientRect(), bird = node.getBoundingClientRect();
    const width = Math.min(320, box.width - 24), height = details.offsetHeight || 260;
    let left = bird.right - box.left + 18;
    if (left + width > box.width - 12) left = bird.left - box.left - width - 18;
    left = Math.max(12, Math.min(left, box.width - width - 12));
    const top = Math.max(12, Math.min(bird.top - box.top + bird.height / 2 - height / 2, box.height - height - 12));
    details.style.setProperty('left', `${left}px`);
    details.style.setProperty('top', `${top}px`);
  }

  function describe({ agent, models, model, leader }) {
    const close = element('button', 'flock-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close and fly on');
    close.addEventListener('click', event => { event.stopPropagation(); clear(); });
    const total = models.reduce((sum, item) => sum + (item.used || 0), 0);
    const head = (title, subtitle) => {
      const top = element('div', 'flock-card-head');
      const copy = element('div', 'flock-card-title');
      copy.append(element('strong', '', title), element('span', '', subtitle));
      top.append(agentTile(agent.id, agent.label), copy, close);
      return top;
    };
    const meter = (share, label) => {
      const wrap = element('div', 'flock-share');
      const bar = element('span', 'flock-share-bar'), fill = element('span');
      fill.style.setProperty('width', `${Math.max(share > 0 ? 2 : 0, share * 100)}%`);
      bar.append(fill);
      wrap.append(bar, element('small', '', label));
      return wrap;
    };
    const stat = (value, label) => { const node = element('div', 'flock-stat'); node.append(element('strong', '', value), element('span', '', label)); return node; };

    if (leader) {
      const used = models.filter(item => item.used).length;
      const list = element('div', 'flock-model-list');
      for (const item of [...models].sort((a, b) => (b.used || 0) - (a.used || 0)).slice(0, 6)) {
        const entry = element('button', 'flock-model-item');
        entry.type = 'button';
        const share = total ? (item.used || 0) / total : 0;
        const name = element('span', 'flock-model-name', item.label || item.id);
        const bar = element('span', 'flock-share-bar'), fill = element('span');
        fill.style.setProperty('width', `${share * 100}%`);
        bar.append(fill);
        entry.append(name, bar, element('small', '', item.used ? compact(item.used) : '—'));
        entry.addEventListener('click', event => {
          event.stopPropagation();
          const bird = [...stage.querySelectorAll('.flock-bird')].find(node => node.getAttribute('aria-label') === `${item.label || item.id} on ${agent.label}`);
          if (bird) bird.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        list.append(entry);
      }
      const facts = [agent.version ? `Version ${agent.version}` : '', agent.path].filter(Boolean).join(' · ');
      return [
        head(agent.label, `${models.length} model${models.length === 1 ? '' : 's'} · ${used} used lately`),
        stat(total ? compact(total) : '0', 'tokens in the last 30 days'),
        list,
        ...(facts ? [element('p', 'flock-facts', facts)] : []),
      ];
    }

    const from = { agent: `Listed by ${agent.label}`, settings: `From your ${agent.label} settings`, history: 'Seen in your history', noai: 'Added by you in Noai' }[model.source] || 'Source not reported';
    const ranked = [...models].sort((a, b) => (b.used || 0) - (a.used || 0));
    const rank = ranked.findIndex(item => item.id === model.id) + 1;
    const share = total ? (model.used || 0) / total : 0;
    const id = element('div', 'flock-id');
    const code = element('code', '', model.id);
    const copy = element('button', 'text-button', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async event => {
      event.stopPropagation();
      try { await navigator.clipboard.writeText(model.id); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); }
      catch { copy.textContent = 'Select to copy'; }
    });
    id.append(code, copy);
    const actions = element('div', 'flock-actions');
    if (onChat) {
      const chat = element('button', 'primary-button', 'Chat with this model');
      chat.type = 'button';
      chat.addEventListener('click', event => { event.stopPropagation(); onChat(agent.id, model.id); });
      actions.append(chat);
    }
    const pills = element('div', 'flock-pills');
    pills.append(element('span', `flock-pill${model.used ? ' is-active' : ''}`, model.used ? 'Used lately' : 'Not used lately'), element('span', 'flock-pill', from));
    return [
      head(model.label || model.id, agent.label),
      pills,
      stat(model.used ? compact(model.used) : '0', 'tokens in the last 30 days'),
      meter(share, model.used ? `${Math.round(share * 100)}% of ${agent.label}'s usage · ${rank === 1 ? 'most used' : `#${rank}`} of ${models.length}` : `None of ${agent.label}'s usage lately`),
      id,
      ...(actions.childElementCount ? [actions] : []),
    ];
  }

  sky.addEventListener('click', clear);
  pauseButton.addEventListener('click', () => { userPaused = !userPaused; setPaused(); });
  card.addEventListener('keydown', event => { if (event.key === 'Escape' && selected) { event.stopPropagation(); clear(); } });
  setPaused();

  function draw() {
    for (const flock of flying) {
      flock.lane.setAttribute('transform', `translate(${flock.x.toFixed(1)} ${(flock.y + Math.sin(t * .4 + flock.phase) * 8).toFixed(1)})`);
      for (const bird of flock.birds) bird.node.setAttribute('transform', `translate(${bird.x.toFixed(1)} ${(bird.y + Math.sin(t * 2.2 + bird.phase) * 1.6).toFixed(2)}) scale(${(bird.scale * SIZE).toFixed(2)})`);
    }
  }
  let attached = false;
  function frame(now) {
    if (card.isConnected) attached = true;
    else if (attached) return; // re-rendered or removed: stop for good
    const dt = Math.min(.05, (now - last) / 1000);
    last = now;
    if (!userPaused && !selected && card.offsetParent !== null) {
      t += dt;
      for (const flock of flying) {
        flock.x += flock.species.speed * (flock.hover ? .3 : 1) * dt;
        if (flock.x - flock.span > WIDTH + 40) flock.x = -40;
      }
      draw();
    }
    requestAnimationFrame(frame);
  }
  draw();
  requestAnimationFrame(now => { last = now; frame(now); });

  stage.append(sky, details);
  card.append(stage, toolbar);
  return card;
}
