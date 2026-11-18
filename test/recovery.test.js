import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverJobMessage } from '../src/js/core/recovery.js';
import { normalizeWorkspace } from '../src/js/core/state.js';
import { countdown } from '../src/js/components/jobs.js';

test('job replay replaces partial saved output rather than duplicating it', () => {
  const message = { id: 'm', content: 'First block', runId: 'r', lastEventId: 1, status: 'interrupted' };
  const job = { runId: 'r', status: 'completed', events: [
    { eventId: 1, type: 'text', text: 'First block' },
    { eventId: 2, type: 'waiting', retryAt: 500 },
    { eventId: 3, type: 'resumed' },
    { eventId: 4, type: 'text', text: 'Continued block' },
    { eventId: 5, type: 'done' },
  ] };
  const recovered = recoverJobMessage(message, job);
  assert.equal(recovered.content, 'First block\n\nContinued block');
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.lastEventId, 5);
  assert.deepEqual(recoverJobMessage(recovered, job), recovered);
});

test('stale snapshots cannot overwrite a newer live response', () => {
  const message = { id: 'm', content: 'New response', status: 'streaming', lastEventId: 8 };
  assert.equal(recoverJobMessage(message, { status: 'waiting', events: [{ eventId: 4, type: 'waiting' }] }), message);
});

test('automation preferences and replay cursor survive reload', () => {
  const state = normalizeWorkspace({ preferences: { autoResume: false, backgroundMode: false, manualPlans: { claude: 'Max', cursor: 42 } }, conversations: [{ messages: [{ runId: 'r', role: 'assistant', content: 'saved', lastEventId: 7, status: 'waiting' }] }] });
  assert.equal(state.preferences.autoResume, false);
  assert.equal(state.preferences.backgroundMode, false);
  assert.deepEqual(state.preferences.manualPlans, { claude: 'Max' });
  assert.equal(state.conversations[0].messages[0].runId, 'r');
  assert.equal(state.conversations[0].messages[0].lastEventId, 7);
  assert.equal(state.conversations[0].messages[0].status, 'interrupted');
});

test('reset countdown handles past and unknown resets honestly', () => {
  assert.equal(countdown(100, 101000), 'Checking availability');
  assert.equal(countdown(undefined, 101000), 'Time unavailable');
  assert.equal(countdown(3760, 100000), 'In 1h 1m');
});
