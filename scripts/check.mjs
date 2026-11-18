import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = await readdir(new URL('../src/', import.meta.url), { recursive: true });
let failed = false;
for (const file of files.filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', `src/${file}`], { stdio: 'inherit' });
  failed ||= result.status !== 0;
}
const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
if (/\s(?:style|on\w+)\s*=/i.test(html) || /<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
  console.error('Keep inline styles, event handlers, and scripts out of HTML.');
  failed = true;
}
if (failed) process.exit(1);
console.log(`JavaScript syntax and HTML separation checks passed.`);
