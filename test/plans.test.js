import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countdown, windowPace } from '../src/js/components/plans.js';

test('countdowns read naturally at every scale', () => {
  assert.equal(countdown(45), '45s');
  assert.equal(countdown(125), '2m 05s');
  assert.equal(countdown(4 * 3600 + 12 * 60 + 8), '4h 12m 08s');
  assert.equal(countdown(2 * 86400 + 3 * 3600), '2d 3h 00m');
  assert.equal(countdown(-5), '0s');
});

test('pace uses the reported window length, and only when there is one', () => {
  const now = 10_000;
  // 5-hour window, 3 hours left (40% gone), 20% used: on pace.
  assert.deepEqual(windowPace({ usedPercent: 20, resetsAt: now + 3 * 3600, windowSeconds: 5 * 3600 }, now), { used: 20, left: 10800, elapsed: 0.4, runsOutIn: null });
  // 2 of 5 hours gone and 80% used: runs out in 30 minutes, well before the reset.
  const fast = windowPace({ usedPercent: 80, resetsAt: now + 3 * 3600, windowSeconds: 5 * 3600 }, now);
  assert.equal(Math.round(fast.runsOutIn), 1800);
  // No reported length: just the countdown.
  assert.deepEqual(windowPace({ usedPercent: 50, resetsAt: now + 60 }, now), { used: 50, left: 60, elapsed: null, runsOutIn: null });
});
