import test from 'node:test';
import assert from 'node:assert/strict';
import { combineSessions } from '../src/js/components/sessions.js';

test('session browser merges Noai conversations without duplicating provider sessions', () => {
  const local = [{id:'file',sessionId:'provider',harness:'codex'}];
  const chats = [
    {id:'represented',harness:'codex',resumeId:'provider',messages:[]},
    {id:'different-harness',harness:'claude',resumeId:'provider',messages:[{content:'Hi'}],createdAt:'2026-01-01',updatedAt:'2026-01-02'},
    {id:'local-only',harness:'codex',messages:[],createdAt:'2026-01-01',updatedAt:'2026-01-02'},
  ];
  const result = combineSessions(local, chats);
  assert.equal(result.length, 3);
  assert.equal(result[1].messageCount, 1);
  assert.equal(result[2].id, 'noai:local-only');
  assert.ok(Number.isFinite(result[1].updatedAt));
});
