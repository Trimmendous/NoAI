// Headless daemon digest check with a fake Claude CLI; never invokes a paid agent.
// Run after `cargo build`: node test/digest-smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { sendRequest } = await import('../bin/noai');

const root = await mkdtemp(path.join(os.tmpdir(), 'noai-digest-'));
const fixtures = path.join(root, 'bin');
const project = path.join(root, 'project');
const dataDir = path.join(root, 'data');
const prompts = path.join(root, 'prompts.txt');
await mkdir(fixtures); await mkdir(project);
await writeFile(path.join(fixtures, 'claude'), `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('Claude fixture'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({accountUuid:'fixture'})); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
const fs = await import('node:fs');
fs.appendFileSync(process.env.NOAI_FIXTURE_PROMPTS, input + '\\n=====\\n');
const text = input.includes('Noai daily digest')
  ? '# Daily digest — fixture\\n\\n## Jobs\\n| Job | Runs |\\n| --- | --- |\\n| Fixture job | 1 |\\n\\nsaw-job:' + input.includes('Fixture job')
  : 'Fixture job finished.';
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',usage:{input_tokens:11,output_tokens:3}}));
`, { mode: 0o755 });

const env = { ...process.env, NOAI_DATA_DIR: dataDir, NOAI_FIXTURE_PROMPTS: prompts, PATH: `${fixtures}:${process.env.PATH}` };
const daemon = spawn(path.resolve('src-tauri/target/debug/noai'), ['--daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let logs = ''; daemon.stderr.on('data', chunk => logs += chunk);
const socket = path.join(dataDir, 'control.sock');
const call = async request => { const response = await sendRequest(socket, request); if (!response.ok) throw new Error(response.error); return response.data; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch {} await sleep(300); }
  throw new Error(`Timed out. ${logs}`);
}
try {
  await until(() => call({ command: 'ping' }));
  const now = Math.floor(Date.now() / 1000);
  const job = await call({ command: 'create', input: { title: 'Fixture job', prompt: 'Do the fixture work', harness: 'claude', projectPath: project, startAt: now, autoResume: false } });
  await until(async () => (await call({ command: 'list' })).find(task => task.id === job.id)?.status === 'completed');

  const digest = await call({ command: 'set_digest', input: { enabled: true, harness: 'claude', model: 'haiku', startAt: now + 3600 } });
  assert.equal(digest.kind, 'digest');
  assert.equal(digest.permissions, 'provider-default');
  await call({ command: 'run_digest_now' });
  const done = await until(async () => {
    const state = await call({ command: 'get_digest' });
    return state.runs[0]?.status === 'completed' ? state : null;
  });
  const text = done.runs[0].events.filter(event => event.type === 'text').at(-1).text;
  assert.match(text, /^# Daily digest/);
  assert.match(text, /saw-job:true/, 'digest prompt contains the real job data');
  assert.equal(done.task.nextRunAt, now + 3600, 'run-now keeps the daily schedule');
  const sent = await readFile(prompts, 'utf8');
  assert.match(sent, /"title": "Fixture job"/);
  assert.match(sent, /"succeeded": 1/);

  const off = await call({ command: 'set_digest', input: { enabled: false, harness: 'claude', model: null, startAt: 0 } });
  assert.equal(off.status, 'disabled');
  console.log('Digest smoke passed: job run → digest prompt with live job data → stored report; schedule kept; disable works.');
} finally {
  daemon.kill('SIGTERM');
  await sleep(300);
  await rm(root, { recursive: true, force: true });
}
