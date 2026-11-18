import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { practiceCommand } from '../src/js/components/job-guide-command.js';

test('practice shell command preserves literal substitutions, quotes and spaces without executing them', () => {
  const title = "Review 'quotes' $(exit 73) `exit 74`";
  const prompt = 'Inspect "$HOME"; exit 75';
  const command = practiceCommand({title, prompt, project:''});
  const result = spawnSync('/bin/sh', ['-c', command.replace('--format text', '--format json')], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.request.input.title, title);
  assert.equal(preview.request.input.prompt, prompt);
  assert.equal(preview.request.input.projectPath, '');
  assert.equal(preview.dryRun, true);
});
test('practice command rejects empty fields and terminal control characters', () => {
  for (const title of [' ', 'bad\nvalue', '\u001b[31m', '--help']) {
    assert.throws(() => practiceCommand({title, prompt:'Inspect', project:'.'}));
  }
});
