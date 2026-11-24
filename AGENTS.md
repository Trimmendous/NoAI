# Noai: notes for coding agents

The README is written for people. This file holds the details you need to work on the code, or to drive Noai for a user.

## Ground rules for the codebase

- Stack: Tauri 2, Rust and Tokio on the backend, and plain HTML/CSS/JavaScript on the frontend. There is no framework, no bundler, no remote fonts and no production JS dependencies. Keep it that way.
- The CSP is `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:`. That rules out inline `<script>`, inline `style=""` attributes and `<style>` blocks. Setting styles through the CSSOM (`el.style.width = …`) is allowed. `npm run check` enforces the HTML/JS separation.
- Colours, radii, shadows and fonts live only in `src/styles/tokens.css`. Components use tokens and never hard-code colours. The exceptions are the fixed status colours for chart errors and the welcome tile, which matches the app icon.
  - Accent presets are blue (the default), purple, sage, amber and graphite. Sidebar icon tiles use the fixed `--tile-*` colours, whatever the accent.
  - A new preset must also be registered in `core/theme.js`, `core/state.js`, `theme-init.js` and the settings radios in `index.html`.
- The UI is Apple-inspired. Build pages from `components/ui.js` (styled in `ui.css`): icon tiles, grouped lists of compact rows, Reminders-style filter tiles and ring gauges. The sidebar is grouped into Overview, Work and Setup. Use: system font, grouped lists of compact rows (Jobs uses Reminders-style filter tiles, search and a "Show more" row so it scales), sheets for forms, a grey backdrop with white rounded cards (`--card-shadow` hairline), pill buttons, iOS-style switches for on/off settings, sentence-case labels and no uppercase eyebrows.
- Agent-written text (chat replies, transcripts, job output, the digest) goes through `components/markdown.js`, styled in `markdown.css`. It builds DOM nodes only, wraps long lines instead of scrolling, and only links `https://` URLs (opened in the system browser via `open_web_link`) and in-app `#session=` routes.
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
  js/components/          DOM rendering (messages, sessions, charts, jobs, digest, models…); ui.js holds the shared tiles, rows, filter tiles and rings
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

Add it to `ALL` in `harness/mod.rs`. Optionally drop a logo at `src/logos/<id>.svg` (or `.png`); without one the agent gets a coloured letter tile. The frontend reads everything through `runtime_status`, so no UI change is needed. The registry test checks that every agent is complete.

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
  - Account and models come from its app-server, plus `model` keys in `config.toml` (top level and profiles).
  - `token_count` events carry running totals; input includes cached tokens.
- **Claude Code:**
  - Runs as `claude --print --output-format stream-json`.
  - Models: aliases documented in `claude --help`, plus `model`, `availableModels` and the model env vars in its settings and environment. There is no hardcoded list; the Models tab also adds models seen in local history.
  - Quota comes from its `rate_limit_event` (5-hour and weekly windows). Noai caches it in `claude-limits.json`. When the cache is older than 10 minutes, it refreshes with a tiny Haiku call using no tools and `--no-session-persistence`.
  - Transcripts live in `~/.claude/projects`. Subagents are in `<session>/subagents/agent-*.jsonl` and are folded into their parent session.
- **Gemini CLI:**
  - Runs as `gemini -p "" --output-format stream-json --skip-trust --approval-mode …`, with the prompt on stdin. `--skip-trust` is needed because headless runs refuse folders the user hasn't trusted in Gemini, so the project's own `.gemini` settings apply.
  - Replies stream as `delta` chunks; the harness buffers them per run and emits whole paragraphs at each tool call and at the result.
  - Models come from `gemini models --output-format json`, plus `model.name` in `~/.gemini/settings.json` and `GEMINI_MODEL`.
  - `result.stats.models` gives per-run tokens per model; `input_tokens` includes `cached`. No account usage or limits are reported.
  - Transcripts live in `~/.gemini/tmp/<project>/chats/session-*.jsonl`. A reply line is rewritten as its tool calls finish, so it's keyed by its `id`; thinking tokens count as output.
- **Other providers:** OpenRouter reads `OPENROUTER_API_KEY`. Copilot and Cursor have no usage adapter; the user can set a plan label by hand.
- **Metrics importer:**
  - Scans `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.claude/projects` and `~/.gemini/tmp`, honouring `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.
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
| Gemini | `workspace-write` (new-job default) | `auto_edit`: file edits, no shell (tools needing approval are unavailable headless) |
| Gemini | `read-only` | `plan` mode |
| Gemini | `provider-default` | `default`: the CLI's own settings and policies |

- **Where modes apply:**
  - Chats and older jobs keep their existing behaviour: Codex uses the CLI config, Claude uses `dontAsk`, Gemini uses `default`.
  - Each job and run saves its mode, including timed resumes. Existing jobs are never migrated.
- **Bypass** (`--dangerously-bypass-permissions true`, or the checkbox):
  - It is a separate opt-in that is off by default.
  - It sends `--dangerously-bypass-approvals-and-sandbox` to Codex, `--dangerously-skip-permissions` to Claude or `--approval-mode yolo` to Gemini.
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
./bin/noai jobs pause TASK_ID      # only a job waiting for its next run
./bin/noai jobs resume TASK_ID     # recurring jobs skip runs missed while paused
./bin/noai jobs cancel TASK_ID
```

- **Options:**
  - `--harness codex|claude|gemini` (Codex is the default) and `--model ID`.
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
  - Any job that hasn't ended (not Cancelled or Completed) can be edited: prompt, model, agent, folder, frequency, permissions. Status, history and the pending resume ID are kept. Only Scheduled and Paused jobs take a new start time; a running run finishes with its old settings and the edit applies from the next run. Ended jobs use Run again instead.
- **Standing job instructions:** Settings › Job instructions holds one text for recurring jobs and one for one-time jobs (`JobInstructions` in the scheduled-tasks journal, owned by the daemon). `claim_due` puts it before the job's prompt; the digest is skipped. Each run's saved `prompt` is the full text sent.
- **Themes:** System, Light, Dark and Matrix. Matrix sets `data-theme='dark'` plus `data-skin='matrix'` (styles/matrix.css), so every dark rule still applies; `components/matrix-rain.js` draws the rain on `#matrix-rain` only while that skin is on, and draws one still frame under reduced motion.
- **Sleep and wake:** `platform::keep_awake(pid)` is held for every agent run (caffeinate / systemd-inhibit / SetThreadExecutionState) and ends with the process. The scheduler loop (`WakePlan` in engine.rs) points one OS wake-up at a minute before the next due job or rate-limit retry, rechecking each minute whether wake-ups are allowed. While waking is on, it also holds the computer awake for the last 3 minutes before anything is due (`hold_until_due`), so a woken machine can't doze off before the run starts. macOS (`pmset schedule wake`) and Linux (`rtcwake`) need a one-time admin approval. It installs a root-owned helper (macOS `/Library/PrivilegedHelperTools/dev.noai.wake`, Linux `/usr/local/libexec/noai-wake`) that accepts only `set|cancel <unix time>` (Linux: `set <time>` or `clear`), and `/etc/sudoers.d/noai-wake`, which allows only that helper. The rule is checked with `visudo -c` first, and nothing is installed if the helper's folder is writable by anyone but root. Never put a wildcard over pmset or rtcwake in the rule: extra flags would run as root. Windows uses a waitable timer and a flag file, with no admin rights needed. Settings › Automation › Sleep turns it on and off (`set_wake_for_jobs`, GUI-side, since it shows the OS prompt).
- **Chat workspace:** `components/workspace.js` keeps open chats as tabs and a tree of split panes (saved in `localStorage` `noai.chatWorkspace`). The focused pane is the active conversation; the single composer, welcome screen and `#messages` are moved into it, so the send, stream and stop code is unchanged. Other panes render their own message log. Drag targets: pane edges split, the centre swaps.
- **Chats in their own windows:** `chat_windows.rs` opens `chat-window.html?id=…` (label `chat-<id>`). The main window stays the owner: it pushes the chat with `noai:chat-window-sync`, and the window sends `noai:chat-window-action` (ready, send, stop, dock). Dropping a tab outside the window tears it off; dragging the window's Dock handle onto a pane docks it.
- **Accessibility:** `core/accessibility.js` (text size via webview zoom, `data-vision` red-green / blue-yellow palettes in `styles/accessibility.css`, `data-contrast`, `data-motion`). New meaningful colours must be tokens that these modes override, never hard-coded.
- **Item analytics:** `components/item-analytics.js` draws the Dashboard's tiles and charts for one job or session's metric rows.
- **Plugins:** see PLUGINS.md. The API runs over a MessageChannel port that `plugins/host.js` hands each frame once, on the SDK's hello. Plugin frames all have the origin `"null"`, so never authorise by `event.origin` or `event.source` alone. Any later load in a frame closes its port and replaces the frame. Rust side: `plugins.rs` (manifests, enabled list in `~/.noai/plugins/enabled.json`, the `noaiplugin://` file server with per-plugin CSP) and `harness/plugin_agent.rs` (agents, registered via `harness::reload_plugins`, also in the daemon via the `reload_plugins` control command). JS side: `plugins/host.js` (sandboxed iframes, permission-checked postMessage API, commands, events, themes) and the SDK in `src/plugin-sdk/`. End-to-end test: `HOME=$(mktemp -d) cargo test plugins_e2e -- --ignored`.
- **Your plans (Dashboard):** `components/plans.js` shows each provider's usage windows with a live countdown. Window lengths come from the provider (`ProviderUsageWindow.window_seconds`: Claude's window keys like `five_hour`, Codex's `windowDurationMins`, OpenRouter's `limit_reset`), never assumed; without one, only the countdown shows. With one, a marker shows how much of the window has passed, and `windowPace` projects when the limit runs out.
- **Worktrees and Changes:** a job with `worktree: true` runs each occurrence in its own git worktree (`worktrees.rs`, under the app data folder's `worktrees/<task>/<run>`) on a branch `noai/<job>-<date>-<id>`; a resumed run continues in the same one. When the run ends, `worktrees::finish` commits whatever is uncommitted and counts the diff; no changes means it's cleaned up at once. Runs with `review: "pending"` show on the Changes page (`components/changes.js`), where merge (main folder must be clean and on the original branch; conflicts abort), publish (push, then `gh pr create` or the host's compare page) and discard go through the daemon (`review_change`). Not a git repo: the run works in the folder and says so. Noai's own git calls run outside the agent sandbox, so `worktrees::git` turns off repo hooks and `core.fsmonitor`. Only Publish's push keeps hooks, because Git LFS uploads from pre-push.
- **Notifications and usage budget:** `AutomationSettings` in the scheduled-tasks journal (`get_automation`/`set_automation`). The daemon sends OS notifications through `platform::notify` (osascript, notify-send, a PowerShell toast) when a job finishes, needs attention, waits for a reset, or is held by the budget. The budget (`reserve_percent`) is checked in `run_scheduled_due` before a claimed run starts: if any usage window of the job's agent is at or above 100 − reserve, the claim is undone (`ScheduledTasks::defer`) and the job is rescheduled for that window's reset. Running jobs are never stopped.
- **CLI warnings:** `Harness::stderr_notice` turns a stderr line into a `notice` run event, shown even when the run succeeds (e.g. Claude Code ignoring an untrusted project's `.claude/settings.json` permissions).
- **Pausing:** `paused` means the user paused it; it is not an error and does not show under Needs you. A paused job keeps its settings and history.
- **Retrying:**
  - `jobs retry` queues a failed, needs-attention or cancelled job at least a minute from now, and never before a known reset.
  - It continues the saved provider session when one exists.
- **Unattended instructions:** every scheduled run gets `unattended-job.md` prepended. Restart an idle daemon after changing that file.
- **Daily digest:**
  - The user can type their own instructions in the Digest tab. Left blank, the default groups the day's jobs and sessions into categories with a plain-English explanation each, `#session=` links, usage and suggestions (`digest.rs`). Its fixed rules (no invented data or links, no tools) always apply.
  - Runs read-only (Codex `read-only`, Claude `dontAsk`, Gemini `plan`) in `~/.noai/digest` on a fixed 24-hour interval.
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
