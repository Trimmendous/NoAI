// macOS LaunchAgent management for `noai service`. Mirrors the systemd user
// service: install enables it for future logins, start launches it now, stop
// leaves it enabled, uninstall removes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Keep in sync with LAUNCHD_LABEL in src-tauri/src/daemon.rs.
export const launchdLabel = 'dev.noai.daemon';

export function plistFile(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${launchdLabel}.plist`);
}

export function logFile(home = os.homedir()) {
  return path.join(home, 'Library', 'Logs', 'noai', 'daemon.log');
}

function xml(value) {
  if (/[\0]/.test(value)) throw new Error('Service paths and PATH cannot contain NUL bytes');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function launchdPlist(binary, environmentPath, log) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${launchdLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(binary)}</string>
    <string>--daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(environmentPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function domain() {
  return `gui/${process.getuid()}`;
}

function launchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot run launchctl: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`launchctl ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function loaded() {
  return launchctl(['print', `${domain()}/${launchdLabel}`], { allowFailure: true }).status === 0;
}

export function manageLaunchdService(command, binary, env = process.env, home = os.homedir()) {
  const file = plistFile(home);
  const target = `${domain()}/${launchdLabel}`;
  if (command === 'install') {
    fs.accessSync(binary, fs.constants.X_OK);
    const log = logFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
    const environmentPath = env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
    fs.writeFileSync(file, launchdPlist(binary, environmentPath, log), { mode: 0o644 });
    // Reload a previously loaded agent so the new binary/PATH take effect at next start.
    if (loaded()) launchctl(['bootout', target], { allowFailure: true });
    return `Installed ${file}; it starts at login. Run noai service start to launch it now.`;
  }
  if (!fs.existsSync(file) && command !== 'status') {
    throw new Error(`${file} is not installed. Run noai service install first.`);
  }
  if (command === 'start') {
    if (loaded()) launchctl(['kickstart', target]);
    else launchctl(['bootstrap', domain(), file]);
    return `Noai service started (logs: ${logFile(home)}).`;
  }
  if (command === 'stop') {
    if (loaded()) launchctl(['bootout', target]);
    return 'Noai service stopped. It will start again at next login while installed.';
  }
  if (command === 'status') {
    const enabled = fs.existsSync(file) ? 'enabled' : 'disabled';
    if (!loaded()) return `${launchdLabel}: inactive, ${enabled}`;
    const printed = launchctl(['print', target], { allowFailure: true }).stdout;
    const state = /^\s*state = (\S+)/m.exec(printed)?.[1] ?? 'unknown';
    return `${launchdLabel}: ${state === 'running' ? 'active' : state}, ${enabled}`;
  }
  if (command === 'uninstall') {
    if (loaded()) launchctl(['bootout', target], { allowFailure: true });
    fs.unlinkSync(file);
    return `Uninstalled ${file}.`;
  }
  throw new Error(`Unknown service command: ${command}`);
}
