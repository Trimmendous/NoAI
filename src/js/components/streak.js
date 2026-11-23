import { element } from './dom.js';
import { computeStreak } from '../core/streak.js';

// The Dashboard's streak tile: a flame drawn in SVG and animated with CSS only.
// The animation grows with the streak, from a still ember to a colour-shifting
// blaze with sparks and a ring, and dims while today's activity is still missing.

const NS = 'http://www.w3.org/2000/svg';
const LABEL = { cold: 'No streak yet', spark: 'Just lit', kindle: 'Warming up', blaze: 'On fire', inferno: 'Blazing', legend: 'Legendary' };
const SEEN_KEY = 'noai.streak-seen';

function flame() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'streak-flame');
  const shape = (className, d) => { const path = document.createElementNS(NS, 'path'); path.setAttribute('class', className); path.setAttribute('d', d); return path; };
  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('class', 'streak-ring'); ring.setAttribute('cx', '24'); ring.setAttribute('cy', '26'); ring.setAttribute('r', '20');
  svg.append(ring,
    shape('streak-outer', 'M24 4c2 7 10 11 11 21 1 9-5 17-11 17s-12-8-11-17c.5-5 3-8 5-10 0 4 1 6 3 7-1-7 1-13 3-18z'),
    shape('streak-inner', 'M24 22c1 4 6 6 6 12 0 4-3 7-6 7s-6-3-6-7c0-3 2-5 3-6 0 2 1 3 2 3 0-3 0-6 1-9z'));
  for (let index = 0; index < 5; index += 1) {
    const spark = document.createElementNS(NS, 'circle');
    spark.setAttribute('class', `streak-spark streak-spark-${index + 1}`);
    spark.setAttribute('cx', String(16 + index * 4)); spark.setAttribute('cy', '30'); spark.setAttribute('r', '1.4');
    svg.append(spark);
  }
  return svg;
}

/** `times` are the epoch seconds of agent activity. */
export function streakCard(times) {
  const streak = computeStreak(times);
  const card = element('div', `ui-filter ui-stat metrics-stat streak-card is-${streak.tier}${streak.current && !streak.activeToday ? ' is-at-risk' : ''}`);
  card.style.setProperty('--filter', 'var(--tile-alert)');
  const top = element('span', 'ui-filter-top');
  const value = element('strong', 'metrics-stat-value', `${streak.current} day${streak.current === 1 ? '' : 's'}`);
  top.append(flame(), value);
  const note = !streak.current ? 'Use an agent today to start one'
    : !streak.activeToday ? 'Use an agent today to keep it going'
      : `${LABEL[streak.tier]} · best ${streak.longest} day${streak.longest === 1 ? '' : 's'}`;
  card.append(top, element('span', 'ui-filter-label metric-label', 'Streak'), element('small', '', note));
  card.title = `${streak.current}-day streak · longest ${streak.longest} days. Days with any agent activity, in your local time.`;
  // A one-off burst the first time the dashboard shows a longer streak.
  try {
    const seen = Number(localStorage.getItem(SEEN_KEY) || 0);
    if (streak.current > seen) card.classList.add('is-new');
    localStorage.setItem(SEEN_KEY, String(streak.current));
  } catch { /* storage unavailable */ }
  return card;
}
