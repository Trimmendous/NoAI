// `noai service` entry point: picks the OS service manager for this platform.
//   Linux  → systemd user service (systemd.mjs)
//   macOS  → launchd LaunchAgent  (launchd.mjs)
//   others → not yet supported
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manageSystemdService } from './systemd.mjs';
import { manageLaunchdService } from './launchd.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export function defaultBinary() {
  for (const mode of ['debug', 'release']) {
    const candidate = path.join(repoRoot, 'src-tauri', 'target', mode, 'noai');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No Noai binary found. Build it with cargo, or pass service install --binary /absolute/path/to/noai');
}

const MANAGERS = { linux: manageSystemdService, darwin: manageLaunchdService };

export function manageService(command, binaryOption, env = process.env, home = os.homedir(), platform = process.platform) {
  const manage = MANAGERS[platform];
  if (!manage) throw new Error(`Noai background services are supported on Linux (systemd) and macOS (launchd); ${platform} is not supported yet`);
  const binary = command === 'install' ? path.resolve(binaryOption || defaultBinary()) : binaryOption;
  return manage(command, binary, env, home);
}
