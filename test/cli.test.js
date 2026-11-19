import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, defaultSocketPath, sendRequest } from '../bin/noai';
import { serviceUnit, serviceFile } from '../scripts/service/systemd.mjs';
import { launchdPlist, plistFile, launchdLabel } from '../scripts/service/launchd.mjs';

test('dry run validates the same options and explicitly opts out of creation', () => {
  const args = ['jobs', 'create', '--title', 'First review', '--prompt', 'Summarize', '--every', '1d'];
  const preview = parse([...args, '--dry-run', 'true']);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.request.input.intervalSeconds, 86400);
  assert.equal(parse(args).dryRun, false);
  assert.equal(parse([...args, '--dry-run', 'false']).dryRun, false);
  assert.throws(() => parse([...args, '--dry-run', 'yes']), /true or false/);
  assert.throws(() => parse([...args, '--dry-run', 'true', '--permissions', 'invalid']), /must be one of/);
  assert.throws(() => parse([...args, '--dry-run', 'true', '--dry-run', 'false']), /repeated/);
});

test('dry run works without a daemon and never creates the proposed project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noai-preview-'));
  try {
    const project = path.join(dir, 'not-created');
    const promptFile = path.join(dir, 'prompt.txt');
    fs.writeFileSync(promptFile, 'Fixture task');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/noai', import.meta.url)),
      'jobs', 'create', '--title', 'Preview', '--prompt-file', promptFile,
      '--project', project, '--socket', path.join(dir, 'absent.sock'), '--dry-run', 'true'], {encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.dryRun, true);
    assert.equal(output.validation, 'cli-options-only');
    assert.equal(output.request.input.prompt, 'Fixture task');
    assert.equal(output.request.input.projectPath, project);
    assert.equal(fs.existsSync(project), false);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

test('creates a recurring task with automatic quota continuation by default', () => {
  const { request } = parse(['jobs', 'create', '--title', 'Review', '--prompt', 'Check tests', '--every', '30m']);
  assert.equal(request.command, 'create');
  assert.equal(request.input.intervalSeconds, 1800);
  assert.equal(request.input.autoResume, true);
  assert.equal(request.input.harness, 'codex');
  assert.equal(request.input.projectPath, '');
  assert.equal(request.input.dangerouslyBypassPermissions, false);
});

test('permission bypass requires an explicit boolean and maps to the create request', () => {
  const argv = ['jobs', 'create', '--title', 'Review', '--prompt', 'Check tests'];
  assert.equal(parse([...argv, '--dangerously-bypass-permissions', 'true']).request.input.dangerouslyBypassPermissions, true);
  assert.equal(parse([...argv, '--harness', 'claude', '--dangerously-bypass-permissions', 'false']).request.input.dangerouslyBypassPermissions, false);
  assert.throws(() => parse([...argv, '--dangerously-bypass-permissions', 'yes']), /true or false/);
});

test('job permissions default to useful non-bypass modes and validate per harness', () => {
  const argv = ['jobs', 'create', '--title', 'Permissions', '--prompt', 'Build'];
  assert.equal(parse(argv).request.input.permissions, 'workspace-network');
  assert.equal(parse([...argv, '--harness', 'claude']).request.input.permissions, 'auto-review');
  for (const mode of ['read-only', 'workspace-write', 'workspace-network', 'provider-default']) {
    const input = parse([...argv, '--permissions', mode]).request.input;
    assert.equal(input.permissions, mode);
    assert.equal(input.dangerouslyBypassPermissions, false);
  }
  assert.throws(() => parse([...argv, '--permissions', 'danger-full-access']), /must be one of/);
  assert.throws(() => parse([...argv, '--harness', 'claude', '--permissions', 'workspace-write']), /must be one of/);
});

test('rejects ambiguous prompts and bad schedule options', () => {
  assert.throws(() => parse(['jobs', 'create', '--title', 'X', '--prompt', 'A', '--prompt-file', 'b']), /exactly one/);
  assert.throws(() => parse(['jobs', 'create', '--title', 'X', '--prompt', 'A', '--every', '15s']), /at least 60/);
  assert.throws(() => parse(['jobs', 'create', '--title', 'X', '--prompt', 'A', '--at', '2026-10-09T09:00']), /timezone/);
  assert.throws(() => parse(['jobs', 'create', '--title', 'X', '--prompt', 'A', '--at', '2000-01-01T09:00:00Z']), /future/);
  assert.throws(() => parse(['jobs', 'create', '--title', 'X', '--prompt', 'A', '--auto-resume', 'yes']), /true or false/);
});

test('manual retry defaults to one minute and validates a chosen schedule', () => {
  const before = Math.floor(Date.now()/1000);
  const request = parse(['jobs','retry','task-1']).retry;
  assert.equal(request.id,'task-1');
  assert.ok(request.startAt >= before+60);
  const at = new Date(Date.now()+3600000).toISOString();
  assert.equal(parse(['jobs','retry','task-1','--at',at]).retry.startAt, Math.floor(Date.parse(at)/1000));
  assert.throws(() => parse(['jobs','retry']), /requires/);
  assert.throws(() => parse(['jobs','retry','task-1','task-2']), /requires/);
});

test('parses auto-resume updates and XDG socket location', () => {
  assert.deepEqual(parse(['jobs', 'update-auto-resume', 'task-1', 'false']).request,
    { command: 'update_auto_resume', id: 'task-1', enabled: false });
  assert.equal(defaultSocketPath({ XDG_DATA_HOME: '/tmp/example' }, '/home/test', 'linux'),
    '/tmp/example/dev.noai.desktop/control.sock');
  assert.equal(defaultSocketPath({ XDG_DATA_HOME: '/tmp/example' }, '/Users/test', 'darwin'),
    '/Users/test/Library/Application Support/dev.noai.desktop/control.sock');
});

test('works through a PATH symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noai-cli-link-test-'));
  try {
    const link = path.join(dir, 'noai');
    fs.symlinkSync(fileURLToPath(new URL('../bin/noai', import.meta.url)), link);
    const result = spawnSync(link, ['help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Noai CLI/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parses service commands and quotes systemd unit fields', () => {
  assert.deepEqual(parse(['service', 'install', '--binary', '/tmp/noai build']), { service: 'install', binary: '/tmp/noai build' });
  assert.deepEqual(parse(['service', 'start']), { service: 'start' });
  assert.throws(() => parse(['service', 'install', '--binary', 'relative/noai']), /absolute/);
  assert.throws(() => parse(['service', 'stop', '--binary', '/tmp/noai']), /takes no arguments/);
  assert.equal(serviceFile({ XDG_CONFIG_HOME: '/tmp/config' }, '/home/example'), '/tmp/config/systemd/user/noai.service');
  const unit = serviceUnit('/tmp/noai % $ build', '/tmp/has $HOME:%:/usr/bin');
  assert.match(unit, /ExecStart="\/tmp\/noai %% \$\$ build" --daemon/);
  assert.match(unit, /Environment="PATH=\/tmp\/has \$HOME:%%:\/usr\/bin"/);
  assert.match(unit, /WantedBy=default.target/);
});

test('service install and lifecycle use only the fake user systemctl', { skip: process.platform !== 'linux' && 'systemd service is Linux-only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noai-service-test-'));
  try {
    const fakeSystemctl = path.join(dir, 'systemctl');
    const calls = path.join(dir, 'calls');
    const binary = path.join(dir, 'noai binary');
    fs.symlinkSync(process.execPath, binary);
    fs.writeFileSync(fakeSystemctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NOAI_TEST_CALLS"\ncase "$2" in is-active) if [ "$NOAI_TEST_INACTIVE" = 1 ]; then echo inactive; exit 3; else echo active; fi;; is-enabled) if [ "$NOAI_TEST_INACTIVE" = 1 ]; then echo disabled; exit 1; else echo enabled; fi;; esac\n', { mode: 0o755 });
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config'), NOAI_TEST_CALLS: calls, PATH: `${dir}:${process.env.PATH}` };
    const cli = fileURLToPath(new URL('../bin/noai', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [cli, 'service', ...args], { env, encoding: 'utf8' });
    const installed = run('install', '--binary', binary);
    assert.equal(installed.status, 0, installed.stderr);
    const unit = fs.readFileSync(path.join(dir, 'config/systemd/user/noai.service'), 'utf8');
    assert.match(unit, /ExecStart=".*noai binary" --daemon/);
    assert.match(unit, /Environment="PATH=/);
    for (const command of ['start', 'status', 'stop', 'uninstall']) {
      const result = run(command);
      assert.equal(result.status, 0, result.stderr);
    }
    const inactive = spawnSync(process.execPath, [cli, 'service', 'status'], { env: { ...env, NOAI_TEST_INACTIVE: '1' }, encoding: 'utf8' });
    assert.equal(inactive.status, 0, inactive.stderr);
    assert.match(inactive.stdout, /inactive, disabled/);
    assert.equal(fs.existsSync(path.join(dir, 'config/systemd/user/noai.service')), false);
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [
      '--user daemon-reload', '--user enable noai.service', '--user start noai.service',
      '--user is-active noai.service', '--user is-enabled noai.service',
      '--user stop noai.service', '--user disable --now noai.service', '--user daemon-reload',
      '--user is-active noai.service', '--user is-enabled noai.service',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launchd plist escapes paths and restarts only on failure', () => {
  const plist = launchdPlist('/tmp/a & <b>/noai', '/opt/homebrew/bin:/usr/bin', '/tmp/log');
  assert.match(plist, /<string>\/tmp\/a &amp; &lt;b&gt;\/noai<\/string>\n\s*<string>--daemon<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\n\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
  assert.match(plist, new RegExp(`<string>${launchdLabel}</string>`));
  assert.equal(plistFile('/Users/example'), `/Users/example/Library/LaunchAgents/${launchdLabel}.plist`);
});

test('service lifecycle on macOS uses only the fake launchctl', { skip: process.platform !== 'darwin' && 'launchd service is macOS-only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noai-launchd-test-'));
  try {
    const calls = path.join(dir, 'calls');
    const loadedFlag = path.join(dir, 'loaded');
    const binary = path.join(dir, 'noai binary');
    fs.symlinkSync(process.execPath, binary);
    fs.writeFileSync(path.join(dir, 'launchctl'), `#!/bin/sh
printf "%s\\n" "$1" >> "$NOAI_TEST_CALLS"
case "$1" in
  print) if [ -f "$NOAI_TEST_LOADED" ]; then echo "	state = running"; exit 0; else exit 113; fi;;
  bootstrap) touch "$NOAI_TEST_LOADED";;
  bootout) rm -f "$NOAI_TEST_LOADED";;
esac
`, { mode: 0o755 });
    const env = { ...process.env, HOME: dir, NOAI_TEST_CALLS: calls, NOAI_TEST_LOADED: loadedFlag, PATH: `${dir}:${process.env.PATH}` };
    const cli = fileURLToPath(new URL('../bin/noai', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [cli, 'service', ...args], { env, encoding: 'utf8' });
    assert.equal(run('install', '--binary', binary).status, 0);
    const file = path.join(dir, 'Library/LaunchAgents', `${launchdLabel}.plist`);
    assert.match(fs.readFileSync(file, 'utf8'), /noai binary<\/string>/);
    assert.match(run('status').stdout, /inactive, enabled/);
    const started = run('start');
    assert.equal(started.status, 0, started.stderr);
    assert.match(run('status').stdout, /active, enabled/);
    assert.equal(run('stop').status, 0);
    assert.equal(run('uninstall').status, 0);
    assert.equal(fs.existsSync(file), false);
    assert.match(run('status').stdout, /inactive, disabled/);
    const sequence = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.ok(sequence.includes('bootstrap') && sequence.includes('bootout'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sends one JSON line to the local control socket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noai-cli-test-'));
  const socketPath = path.join(dir, 'control.sock');
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let body = '';
    socket.on('data', chunk => { body += chunk; });
    socket.on('end', () => {
      assert.deepEqual(JSON.parse(body), { command: 'list' });
      socket.end('{"ok":true,"data":[]}\n');
    });
  });
  try {
    await new Promise(resolve => server.listen(socketPath, resolve));
    assert.deepEqual(await sendRequest(socketPath, { command: 'list' }), { ok: true, data: [] });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readable dry runs remain offline and require explicit dry-run mode', () => {
  const args = ['jobs', 'create', '--title', 'Preview', '--prompt', 'Inspect', '--format', 'text'];
  assert.throws(() => parse(args), /requires --dry-run/);
  assert.throws(() => parse([...args, '--dry-run', 'false']), /requires --dry-run/);
  assert.throws(() => parse([...args.slice(0,-1), 'xml', '--dry-run', 'true']), /json or text/);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/noai', import.meta.url)), ...args,
    '--dry-run', 'true', '--socket', '/tmp/noai-absent-fixture.sock', '--every', '1d'], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No job created/);
  assert.match(result.stdout, /86400 seconds/);
  assert.match(result.stdout, /Not checked: provider readiness/);
});

test('create previews and retries reject impossible calendar dates before contacting the daemon', () => {
  for (const at of ['2099-02-29T12:00Z', '2099-04-31T12:00Z', '2099-01-01T24:00Z']) {
    assert.throws(() => parse(['jobs','create','--title','Review','--prompt','Inspect','--dry-run','true','--at',at]), /calendar/);
    assert.throws(() => parse(['jobs','retry','fixture','--at',at]), /calendar/);
  }
});
