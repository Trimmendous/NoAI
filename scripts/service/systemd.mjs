// Linux systemd user service for `noai service`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const serviceName = 'noai.service';

function unitQuote(value, exec = false) {
  if (/[\r\n\0]/.test(value)) throw new Error('Service paths and PATH cannot contain line breaks or NUL bytes');
  let quoted = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (exec) quoted = quoted.replaceAll('$', () => '$$');
  return `"${quoted}"`;
}

export function serviceFile(env = process.env, home = os.homedir()) {
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(config, 'systemd', 'user', serviceName);
}

export function serviceUnit(binary, environmentPath) {
  return `[Unit]\nDescription=Noai background scheduler\n\n[Service]\nType=simple\nExecStart=${unitQuote(binary, true)} --daemon\nEnvironment=${unitQuote(`PATH=${environmentPath}`)}\nRestart=on-failure\nRestartSec=5s\nKillMode=control-group\nTimeoutStopSec=30s\n\n[Install]\nWantedBy=default.target\n`;
}

function systemctl(...args) {
  const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot run systemctl --user: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`systemctl --user ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function systemctlState(command) {
  const result = spawnSync('systemctl', ['--user', command, serviceName], { encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot run systemctl --user: ${result.error.message}`);
  const state = result.stdout.trim();
  if (!state) throw new Error(`systemctl --user ${command} failed: ${result.stderr.trim()}`);
  return state;
}

export function manageSystemdService(command, binary, env = process.env, home = os.homedir()) {
  const file = serviceFile(env, home);
  if (command === 'install') {
    fs.accessSync(binary, fs.constants.X_OK);
    const environmentPath = env.PATH || '/usr/local/bin:/usr/bin:/bin';
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, serviceUnit(binary, environmentPath), { mode: 0o600 });
    systemctl('daemon-reload');
    systemctl('enable', serviceName);
    return `Installed and enabled ${file}. Run noai service start to launch it.`;
  }
  if (command === 'start') {
    systemctl('start', serviceName);
    return 'Noai service started.';
  }
  if (command === 'stop') {
    systemctl('stop', serviceName);
    return 'Noai service stopped.';
  }
  if (command === 'status') {
    const active = systemctlState('is-active');
    const enabled = systemctlState('is-enabled');
    return `${serviceName}: ${active}, ${enabled}`;
  }
  if (command === 'uninstall') {
    systemctl('disable', '--now', serviceName);
    fs.unlinkSync(file);
    systemctl('daemon-reload');
    return `Uninstalled ${file}.`;
  }
  throw new Error(`Unknown service command: ${command}`);
}
