import test from 'node:test';
import assert from 'node:assert/strict';
import { nextLocalOccurrence, localTimeOf, digestText, isEnabled } from '../src/js/components/digest.js';

test('next digest time is the next future local occurrence', () => {
  const now = new Date(2026, 10, 19, 9, 30);
  const later = new Date(nextLocalOccurrence('17:05', now) * 1000);
  assert.deepEqual([later.getDate(), later.getHours(), later.getMinutes()], [19, 17, 5]);
  const tomorrow = new Date(nextLocalOccurrence('08:00', now) * 1000);
  assert.deepEqual([tomorrow.getDate(), tomorrow.getHours()], [20, 8]);
  const same = new Date(nextLocalOccurrence('09:30', now) * 1000);
  assert.equal(same.getDate(), 20, 'the current minute is not in the future');
  assert.equal(nextLocalOccurrence('', now), 0);
  assert.equal(localTimeOf(nextLocalOccurrence('07:45', now)), '07:45');
});

test('digest text is the final non-empty assistant message', () => {
  const run = { events: [
    { type: 'text', text: 'Reading the data…' },
    { type: 'activity', text: 'Read' },
    { type: 'text', text: '# Daily digest\nAll good.' },
    { type: 'text', text: '   ' },
  ] };
  assert.equal(digestText(run), '# Daily digest\nAll good.');
  assert.equal(digestText({ events: [] }), '');
  assert.equal(digestText(null), '');
});

test('digest is enabled unless missing, disabled or cancelled', () => {
  assert.equal(isEnabled(null), false);
  assert.equal(isEnabled({ status: 'disabled' }), false);
  assert.equal(isEnabled({ status: 'cancelled' }), false);
  assert.equal(isEnabled({ status: 'scheduled' }), true);
  assert.equal(isEnabled({ status: 'running' }), true);
});

import { preferredHarness, harnessOptionLabel, getHarness, setHarnesses, HARNESSES } from '../src/js/core/catalog.js';

test('agent pickers default to an installed agent', () => {
  setHarnesses([{ id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude Code' }]);
  const onlyClaude = [{ id: 'codex', installed: false }, { id: 'claude', installed: true }];
  assert.equal(preferredHarness(onlyClaude), 'claude');
  assert.equal(preferredHarness(onlyClaude, 'codex'), 'claude');
  assert.equal(preferredHarness([{ id: 'codex', installed: true }, { id: 'claude', installed: true }], 'claude'), 'claude');
  assert.equal(preferredHarness([], 'claude'), 'claude');
  assert.equal(preferredHarness([]), 'codex');
  assert.equal(harnessOptionLabel(getHarness('codex'), onlyClaude), 'Codex (not detected)');
  assert.equal(harnessOptionLabel(getHarness('claude'), onlyClaude), 'Claude Code');
});

test('the agent list comes from the backend and is validated', () => {
  setHarnesses([{ id: 'opencode', label: 'OpenCode', permissions: [{ id: 'read-only', label: 'Read only', description: 'x' }] }, { id: 'opencode' }, { id: '../bad' }, null]);
  assert.deepEqual(HARNESSES.map(item => item.id), ['opencode']);
  assert.equal(getHarness('opencode').permissions[0].id, 'read-only');
  setHarnesses([{ id: 'newagent' }]);
  assert.equal(getHarness('newagent').label, 'newagent');
  assert.equal(getHarness('newagent').permissions[0].id, 'provider-default');
  assert.equal(getHarness('opencode'), null);
  setHarnesses([]);
});
