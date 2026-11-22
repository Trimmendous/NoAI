import { element } from './dom.js';
import { agentTile, relativeTime } from './ui.js';

// Dashboard › Your plans: every subscription Noai can read, with each usage
// window's live countdown. Window lengths come from the provider (a 5-hour or
// weekly window for Claude today); when a length is reported, Noai also shows
// how far through the window you are and whether you're on pace.

/** "4h 12m 08s", "2d 3h", "45s". */
export function countdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (d) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

const duration = seconds => {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 86400) return `${Math.round(s / 3600 / 24 * 10) / 10} days`;
  if (s >= 3600) { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return m ? `${h} h ${m} min` : `${h} h`; }
  return `${Math.max(1, Math.round(s / 60))} min`;
};

/**
 * Where a window stands at `now`: how much time has passed, and (with enough
 * elapsed time) when the limit would run out at the current rate.
 */
export function windowPace(window, now) {
  const used = Math.max(0, Math.min(100, window.usedPercent ?? 0));
  const left = window.resetsAt ? Math.max(0, window.resetsAt - now) : null;
  if (!window.windowSeconds || left === null) return { used, left, elapsed: null, runsOutIn: null };
  const elapsed = Math.min(1, Math.max(0, 1 - left / window.windowSeconds));
  const spent = elapsed * window.windowSeconds;
  // Too early in the window, or nothing used: no projection.
  if (used <= 0 || spent < 300) return { used, left, elapsed, runsOutIn: null };
  const runsOutIn = (100 - used) / (used / spent);
  return { used, left, elapsed, runsOutIn: runsOutIn < left ? runsOutIn : null };
}

export function initPlans(container, { onReset, openAccounts }) {
  let snapshots = [], timer = null, resetAsked = new Set();

  function render(list = snapshots) {
    snapshots = list || [];
    const plans = snapshots.filter(snapshot => snapshot.windows?.some(window => window.usedPercent != null || window.resetsAt));
    const head = element('div', 'plans-head');
    head.append(element('h3', '', 'Your plans'));
    const more = element('button', 'text-button', 'Accounts');
    more.type = 'button';
    more.addEventListener('click', openAccounts);
    head.append(more);
    if (!plans.length) {
      container.replaceChildren(head, element('p', 'plans-empty', 'No subscriptions detected yet. Sign in to Claude Code or Codex, and their usage limits appear here with live countdowns.'));
      stop();
      return;
    }
    const grid = element('div', 'plans-grid');
    for (const snapshot of plans) {
      const card = element('article', 'plan-card');
      const top = element('div', 'plan-card-head');
      const copy = element('div', 'plan-card-copy');
      // Compact: name and plan on one line; the account and refresh time are in Accounts.
      copy.append(element('strong', '', snapshot.label), element('span', '', snapshot.plan || ''));
      if (snapshot.fetchedAt) top.title = `${snapshot.accountLabel ? `${snapshot.accountLabel} · ` : ''}Updated ${relativeTime(snapshot.fetchedAt).toLowerCase()}`;
      top.append(agentTile(snapshot.id, snapshot.label, 'is-small'), copy);
      card.append(top);
      for (const window of snapshot.windows || []) {
        const row = element('div', 'plan-window');
        row.dataset.resetsAt = window.resetsAt || '';
        row.dataset.windowSeconds = window.windowSeconds || '';
        row.dataset.used = window.usedPercent ?? '';
        row.dataset.expired = window.expired ? '1' : '';
        const label = element('div', 'plan-window-label');
        label.append(element('span', '', window.label.replace(/ limit$/i, '')), element('strong', 'plan-used', window.usedPercent != null ? `${Math.round(window.usedPercent)}%` : '—'));
        const meter = element('div', 'plan-meter');
        meter.setAttribute('role', 'meter');
        meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100');
        meter.setAttribute('aria-valuenow', String(Math.round(window.usedPercent ?? 0)));
        meter.setAttribute('aria-label', `${window.label}: ${Math.round(window.usedPercent ?? 0)}% used`);
        const fill = element('span', 'plan-meter-fill'), mark = element('span', 'plan-meter-time');
        meter.append(fill, mark);
        const foot = element('div', 'plan-window-foot');
        foot.append(element('span', 'plan-countdown'), element('span', 'plan-pace'));
        row.append(label, meter, foot);
        card.append(row);
      }
      grid.append(card);
    }
    container.replaceChildren(head, grid);
    tick();
    start();
  }

  // Once a second: countdowns, the time marker and the pace line.
  function tick() {
    const now = Date.now() / 1000;
    for (const row of container.querySelectorAll('.plan-window')) {
      const window = { resetsAt: Number(row.dataset.resetsAt) || null, windowSeconds: Number(row.dataset.windowSeconds) || null, usedPercent: row.dataset.used === '' ? null : Number(row.dataset.used) };
      // Past its reset, a window is empty until the agent is used again.
      const expired = row.dataset.expired === '1' || (window.resetsAt && window.resetsAt <= now);
      if (expired) { window.usedPercent = window.usedPercent == null ? null : 0; window.resetsAt = null; }
      const usedNode = row.querySelector('.plan-used');
      if (expired && usedNode && window.usedPercent === 0) usedNode.textContent = '0%';
      const pace = windowPace(window, now);
      const level = pace.used >= 90 ? 'is-bad' : pace.used >= 75 ? 'is-warn' : '';
      row.className = `plan-window ${level}`;
      row.querySelector('.plan-meter-fill').style.setProperty('width', `${pace.used}%`);
      const mark = row.querySelector('.plan-meter-time');
      mark.hidden = pace.elapsed === null;
      if (pace.elapsed !== null) mark.style.setProperty('left', `${pace.elapsed * 100}%`);
      const countdownNode = row.querySelector('.plan-countdown');
      if (expired) {
        countdownNode.textContent = 'Reset · starts again with your next use';
        const key = `${row.dataset.resetsAt}`;
        if (row.dataset.resetsAt && !resetAsked.has(key)) { resetAsked.add(key); onReset(); }
      } else if (pace.left === null) countdownNode.textContent = 'Reset time not reported';
      else if (pace.left <= 0) {
        countdownNode.textContent = 'Resetting now…';
        const key = `${row.dataset.resetsAt}`;
        if (!resetAsked.has(key)) { resetAsked.add(key); onReset(); }
      } else countdownNode.textContent = `Resets in ${countdown(pace.left)}`;
      // Only speak up when the limit would run out before it resets; the marker shows the rest.
      const paceNode = row.querySelector('.plan-pace');
      paceNode.textContent = pace.runsOutIn !== null ? `Runs out in ${duration(pace.runsOutIn)}` : '';
      paceNode.title = pace.runsOutIn !== null ? `At this pace it runs out ${duration(pace.left - pace.runsOutIn)} before the reset` : '';
      row.title = pace.elapsed !== null ? `${Math.round(pace.elapsed * 100)}% of the window has passed` : '';
    }
  }
  function start() { if (!timer) timer = setInterval(() => { if (!document.hidden && container.isConnected && container.offsetParent !== null) tick(); }, 1000); }
  function stop() { clearInterval(timer); timer = null; }

  return { render };
}
