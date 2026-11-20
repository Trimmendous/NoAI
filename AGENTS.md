# Noai: notes for coding agents

The README is written for people. This file holds the details you need to work on the code, or to drive Noai for a user.

## Ground rules for the codebase

- Stack: Tauri 2, Rust and Tokio on the backend, and plain HTML/CSS/JavaScript on the frontend. There is no framework, no bundler, no remote fonts and no production JS dependencies. Keep it that way.
- The CSP is `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:`. That rules out inline `<script>`, inline `style=""` attributes and `<style>` blocks. Setting styles through the CSSOM (`el.style.width = …`) is allowed. `npm run check` enforces the HTML/JS separation.
- Colours, radii, shadows and fonts live only in `src/styles/tokens.css`. Components use tokens and never hard-code colours. The exceptions are the fixed status colours for chart errors and the welcome tile, which matches the app icon.
  - Accent presets are graphite (the default), sage, blue and amber.
  - A new preset must also be registered in `core/theme.js`, `core/state.js`, `theme-init.js` and the settings radios in `index.html`.
- The UI is Apple-inspired: system font, a grey backdrop with white rounded cards (`--card-shadow` hairline), pill buttons, iOS-style switches for on/off settings, sentence-case labels and no uppercase eyebrows.
- A global CSS rule gives every `svg` `stroke: currentColor`. Filled shapes in charts or logos need `stroke: none`.
- Agent-specific code belongs only in `src-tauri/src/harness/`. OS-specific code belongs only in `src-tauri/src/platform/`. Other modules never `cfg` on the OS or name an agent.
- Never fabricate agent output or usage. Missing data shows as "Not reported" or "Unavailable".

## Verify before you finish

```sh
npm run check
npm test
npm run build
npm run rust:test
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo tauri build --debug --no-bundle      # → src-tauri/target/debug/noai
node test/native-smoke.mjs                 # needs the debug build; fake CLIs, no tokens spent
node test/digest-smoke.mjs
```

- **Browser test (optional):** start `npm run dev` (it serves http://127.0.0.1:1420), then run `NOAI_PLAYWRIGHT_MODULE=/abs/path/playwright/index.mjs node test/browser.mjs`. Screenshots go to `/tmp/noai-check/`.
- **Paid inference:** never use it in automated checks.
- **Restarting the daemon:** if the daemon runs as a macOS LaunchAgent, restart it after a rebuild with `launchctl kickstart -k gui/$(id -u)/dev.noai.daemon`.

## Source layout

```text
src/
  index.html              App shell and dialogs (no inline scripts or styles)
  styles/                 tokens, base, layout, components, surfaces (shared cards), page CSS; main.css imports them all
  js/theme-init.js        Early theme loader (prevents a flash)
  js/main.js              App orchestration and event bindings
  js/core/                State, harness catalog, theme, metrics maths
  js/services/            Native bridge, persistence, provider capabilities
  js/components/          DOM rendering (messages, sessions, charts, jobs, digest…)
src-tauri/src/
  harness/                Every agent CLI behind one `Harness` trait; registry `ALL` in mod.rs
  platform/               OS code: mod.rs shared API; unix.rs, macos.rs, linux.rs, windows.rs
  engine.rs               Run lifecycle, cancellation, scheduling
  daemon.rs               Headless scheduler entry point (`noai --daemon`)
  control.rs              Private Unix socket and durable event replay
  ipc.rs / runtime.rs     Desktop client, event relay, IPC forwarding
  providers.rs            Account identity, model discovery, usage adapters
  scheduler.rs            Durable resume journal and event history
  scheduled_tasks.rs      User jobs and run history
  local_metrics.rs        Background importer of local agent history
  local_sessions.rs       Sessions tab: lists and summarises transcripts
  digest.rs               Daily digest prompt
  projects.rs, storage.rs UUID workspaces, atomic writes
  unattended-job.md       Instructions prepended to every scheduled run
bin/noai                  Node CLI that talks to the daemon
scripts/service/          `noai service`: systemd (Linux) or launchd (macOS)
test/                     Unit tests, smoke tests, optional browser test
docs/                     Architecture and roadmap
```

## Adding an agent

Write one file in `src-tauri/src/harness/` that implements `Harness`:

- **Identity:** id, label, executable.
- **Running:** headless argv and JSON output parsing.
- **Settings:** permission modes (default first), the read-only mode used by the digest, and the bypass text.
- **Account:** model discovery, usage and sign-in identity.
- **History (optional):** transcript locations, metrics lines, `session_usage` and `subagent_parent`.

Add it to `ALL` in `harness/mod.rs`. The frontend reads everything through `runtime_status`, so no UI change is needed. The registry test checks that every agent is complete.

## Runtime facts

- **Data directory:**
  - macOS: `~/Library/Application Support/dev.noai.desktop`.
  - Linux: `$XDG_DATA_HOME/dev.noai.desktop`, or `~/.local/share/dev.noai.desktop`.
  - Override it with `NOAI_DATA_DIR` to run an isolated daemon, GUI and CLI.
  - It holds `control.sock`, `daemon-events.jsonl` (no retention limit), `local-metrics-v2.json` and `claude-limits.json`.
- **Control socket:** send one JSON line, e.g. `{"command":"metrics"}`. Shut down the write side, then read until EOF. The CLI accepts `--socket PATH`.
- **Finding agent CLIs:** Noai checks PATH first, then the user's login shell, then common install folders (npm, bun, volta, pnpm, nvm, fnm, Homebrew, `~/.local/bin`, `~/.claude/local`, per-OS locations). Children get those folders on PATH so npm CLIs can find `node`.
- **Codex:**
  - Runs as `codex exec --json` / `exec resume`.
  - Account and models come from its app-server.
  - `token_count` events carry running totals; input includes cached tokens.
- **Claude Code:**
  - Runs as `claude --print --output-format stream-json`.
  - Quota comes from its `rate_limit_event` (5-hour and weekly windows). Noai caches it in `claude-limits.json`. When the cache is older than 10 minutes, it refreshes with a tiny Haiku call using no tools and `--no-session-persistence`.
  - Transcripts live in `~/.claude/projects`. Subagents are in `<session>/subagents/agent-*.jsonl` and are folded into their parent session.
- **Other providers:** OpenRouter reads `OPENROUTER_API_KEY`. Gemini, Copilot and Cursor have no usage adapter; the user can set a plan label by hand.
- **Metrics importer:**
  - Scans `~/.codex/sessions`, `~/.codex/archived_sessions` and `~/.claude/projects`, honouring `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.
  - Reads everything once, then reads only appended bytes every 30 seconds.
  - Repeated Claude message snapshots and Codex running totals are counted once.
  - It never modifies agent logs.
- **Messages:** they arrive as whole assistant blocks, not token deltas.
- **Credentials:** never read or copied. Noai reuses each CLI's own login.

## Permissions

| Agent | Mode | Behaviour |
| --- | --- | --- |
| Codex | `workspace-network` (new-job default) | Sandboxed project writes and commands, network on, no approvals |
| Codex | `workspace-write` | Same, network off |
| Codex | `read-only` | Read-only sandbox |
| Codex | `provider-default` | Existing CLI settings |
| Claude | `auto-review` (new-job default) | Provider's automatic permission review |
| Claude | `provider-default` | Configured rules with `dontAsk` |

- **Where modes apply:**
  - Chats and older jobs keep their existing behaviour: Codex uses the CLI config, Claude uses `dontAsk`.
  - Each job and run saves its mode, including timed resumes. Existing jobs are never migrated.
- **Bypass** (`--dangerously-bypass-permissions true`, or the checkbox):
  - It is a separate opt-in that is off by default.
  - It sends `--dangerously-bypass-approvals-and-sandbox` to Codex or `--dangerously-skip-permissions` to Claude.
  - Use it only when the user has explicitly authorised it for that task.
  - Noai never falls back to bypass.

## Scheduling work for a user

Use `./bin/noai` (run `./bin/noai help` for syntax). It prints JSON, so confirm the task ID and schedule from the output.

```sh
./bin/noai jobs create --title "Review tests" --prompt "Review failing tests" --project /path/to/project --at now
./bin/noai jobs create --title "Morning review" --prompt-file /path/to/prompt.txt --at 2026-10-09T09:00:00-04:00
./bin/noai jobs create --title "Daily review" --prompt "Review open work" --every 1d --auto-resume true
./bin/noai jobs list
./bin/noai jobs runs TASK_ID
./bin/noai jobs update-auto-resume TASK_ID true
./bin/noai jobs retry TASK_ID [--at ISO-8601]
./bin/noai jobs cancel TASK_ID
```

- **Options:**
  - `--harness codex|claude` (Codex is the default) and `--model ID`.
  - `--project` names an existing folder. Leave it out and Noai creates a UUID workspace in `~/.noai`.
  - `--at` takes `now` or a future ISO-8601 time with a timezone.
  - `--every` takes values like `90s`, `30m`, `2h` or `1d`, with a 60-second minimum.
- **Auto-resume (default true):**
  - It continues only after a timed provider limit, 60 seconds after the stated reset. That covers relative delays, reset timestamps and Codex's "try again at 3:23 PM" messages in the host timezone.
  - Billing, authentication and untimed failures need the user's attention.
  - Changing the setting affects only future occurrences.
  - Retries are capped at 8 attempts and a 7-day lifetime.
  - Never promise to get around a provider's limits.
- **How runs behave:**
  - Runs never overlap within one job.
  - Missed occurrences collapse into one run.
  - Failed or interrupted runs stop for review and do not repeat automatically.
  - Only jobs that are still Scheduled can be edited; the edit is rejected once the scheduler claims the occurrence.
- **Retrying:**
  - `jobs retry` queues a failed, paused or cancelled job at least a minute from now, and never before a known reset.
  - It continues the saved provider session when one exists.
- **Unattended instructions:** every scheduled run gets `unattended-job.md` prepended. Restart an idle daemon after changing that file.
- **Daily digest:**
  - Runs read-only (Codex `read-only`, Claude `dontAsk`) in `~/.noai/digest` on a fixed 24-hour interval.
  - It is hidden from the Jobs list.

## Background service

`./bin/noai service install|start|stop|status|uninstall`.

- **macOS:** writes a LaunchAgent at `~/Library/LaunchAgents/dev.noai.daemon.plist`. It runs at login and restarts after a crash. Logs go to `~/Library/Logs/noai/daemon.log`.
- **Linux:** writes a systemd user service. Read its logs with `journalctl --user -u noai.service`. Don't enable lingering unless the user asks.
- **Install details:**
  - Installing captures the current PATH; reinstall if agent paths change.
  - Use `--binary /abs/path/noai` to point at another build.
- **Behaviour:**
  - `service start` takes over an idle standalone daemon. It refuses if runs are active.
  - Closing the GUI leaves work running.
  - A sleeping computer postpones work; Noai never wakes it.
