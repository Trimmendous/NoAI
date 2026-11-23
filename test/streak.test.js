import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStreak, streakTier } from '../src/js/core/streak.js';

const now = new Date(2026, 10, 23, 15);
const day = offset => new Date(2026, 10, 23 + offset, 12).getTime() / 1000;

test('counts consecutive days up to today', () => {
  const s = computeStreak([day(0), day(-1), day(-1), day(-2), day(-4)], now);
  assert.deepEqual([s.current, s.longest, s.activeToday], [3, 3, true]);
});

test('a streak survives until today ends, and breaks after a missed day', () => {
  assert.deepEqual([computeStreak([day(-1), day(-2)], now).current, computeStreak([day(-1)], now).activeToday], [2, false]);
  assert.equal(computeStreak([day(-2), day(-3)], now).current, 0);
});

test('longest streak and tiers', () => {
  const times = Array.from({ length: 10 }, (_, i) => day(-20 - i));
  assert.equal(computeStreak(times, now).longest, 10);
  assert.deepEqual([0, 1, 3, 7, 14, 30].map(streakTier), ['cold', 'spark', 'kindle', 'blaze', 'inferno', 'legend']);
});
