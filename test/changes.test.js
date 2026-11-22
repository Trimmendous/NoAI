import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../src/js/components/changes.js';

test('a unified diff splits into files with counts and line kinds', () => {
  const files = parseDiff([
    'diff --git a/app/readme.txt b/app/readme.txt',
    'index 1..2 100644', '--- a/app/readme.txt', '+++ b/app/readme.txt',
    '@@ -1 +1,2 @@', ' hello', '+world',
    'diff --git a/old.txt b/old.txt', 'deleted file mode 100644', '--- a/old.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
  ].join('\n'));
  assert.deepEqual(files.map(file => [file.path, file.status, file.added, file.removed]), [['app/readme.txt', 'modified', 1, 0], ['old.txt', 'deleted', 0, 1]]);
  assert.deepEqual(files[0].lines.map(line => line.kind), ['hunk', 'ctx', 'add']);
});
