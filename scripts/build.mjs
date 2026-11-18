import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../src/', import.meta.url));
const destination = fileURLToPath(new URL('../dist/', import.meta.url));
await mkdir(destination, { recursive: true });
for (const item of await readdir(destination)) {
  await rm(`${destination}/${item}`, { recursive: true, force: true });
}
await cp(source, destination, { recursive: true });
console.log('Noai built → dist/ (native HTML, CSS, and JavaScript; no bundler).');
