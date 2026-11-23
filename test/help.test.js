import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { HELP_SECTIONS, searchHelp, sectionForView } from '../src/js/components/help.js';

const texts = Object.fromEntries(HELP_SECTIONS.map(section => [section.id, readFileSync(new URL(`../src/help/${section.id}.md`, import.meta.url), 'utf8')]));

test('every help topic has its article', () => {
  for (const section of HELP_SECTIONS) assert.ok(existsSync(new URL(`../src/help/${section.id}.md`, import.meta.url)), section.id);
});

test('help opens on the page you came from', () => {
  assert.equal(sectionForView('job'), 'jobs');
  assert.equal(sectionForView('home'), 'plans');
  assert.equal(sectionForView('nowhere'), 'getting-started');
});

test('search finds the right article for a question', () => {
  assert.equal(searchHelp(texts, 'merge conflict')[0].id, 'changes');
  assert.equal(searchHelp(texts, 'finishes in seconds')[0].id, 'troubleshooting');
  assert.equal(searchHelp(texts, 'split')[0].id, 'chat');
  assert.deepEqual(searchHelp(texts, 'zzqx'), []);
});
