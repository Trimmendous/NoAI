// Day streaks: consecutive local calendar days with any agent activity.

const dayKey = date => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
const shift = (date, days) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };

/**
 * `times` are epoch seconds. Returns { current, longest, activeToday, tier }.
 * A streak survives until the end of the day after its last active day, so
 * "not yet today" still counts (activeToday tells the two apart).
 */
export function computeStreak(times, now = new Date()) {
  const days = new Set(times.filter(Number.isFinite).map(at => dayKey(new Date(at * 1000))));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const activeToday = days.has(dayKey(today));
  let current = 0;
  for (let day = activeToday ? today : shift(today, -1); days.has(dayKey(day)); day = shift(day, -1)) current += 1;
  // Longest: walk the sorted days once.
  const sorted = [...days].map(key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); }).sort((a, b) => a - b);
  let longest = 0, run = 0, previous = null;
  for (const day of sorted) {
    run = previous && dayKey(shift(previous, 1)) === dayKey(day) ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  return { current, longest: Math.max(longest, current), activeToday, tier: streakTier(current) };
}

/** Each tier has its own look and animation. */
export function streakTier(days) {
  return days >= 30 ? 'legend' : days >= 14 ? 'inferno' : days >= 7 ? 'blaze' : days >= 3 ? 'kindle' : days >= 1 ? 'spark' : 'cold';
}
