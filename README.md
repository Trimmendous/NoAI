# Noai

A small local desktop workspace for coding-agent conversations. Built from scratch with **Tauri 2, Rust, and vanilla HTML/CSS/JavaScript**. No React, UI framework, bundler, remote fonts, or production JavaScript dependencies.

## Run

Prerequisites: Node.js 22+, Rust, the Tauri 2 CLI (`cargo install tauri-cli --version '^2'`), and [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/). On Linux, GTK 3 and WebKitGTK 4.1 are required. Install and authenticate Codex or Claude Code separately before using it in Noai.

```sh
cd /path/to/noai
npm run desktop
```

For a browser-only interface preview:

```sh
npm run dev
# http://127.0.0.1:1420
```

The preview can save appearance and conversations in browser storage, but it cannot access local agent processes. It never fabricates agent responses or usage information. The desktop uses its own persistent data directory, separate from the preview and from Jean.

If a preview server is already running on port 1420, stop it before `npm run desktop`, which starts its own server. A compiled native build embeds its frontend and does not need a server.

## Background service on macOS

Build the desktop binary, then install and start a launchd LaunchAgent:

```sh
./bin/noai service install
./bin/noai service start
./bin/noai service status
# Stop execution: ./bin/noai service stop
# Remove service: ./bin/noai service uninstall
```

`install` writes `~/Library/LaunchAgents/dev.noai.daemon.plist`, which launchd starts at each login (`RunAtLoad`) and restarts after a crash (`KeepAlive` on unsuccessful exit). `stop` unloads it until the next login; `uninstall` removes it. Logs go to `~/Library/Logs/noai/daemon.log`. Installation captures the current PATH so the daemon finds your Codex and Claude executables; reinstall if those paths change. Data, including the control socket, lives in `~/Library/Application Support/dev.noai.desktop`. Without the service, opening the GUI starts a standalone daemon and logs to `daemon.log` in that directory. Noai does not wake a sleeping Mac.

## Background service on Linux

Build the desktop binary, then install and start its systemd user service:

```sh
./bin/noai service install
./bin/noai service start
./bin/noai service status
# Stop execution: ./bin/noai service stop
# Remove service: ./bin/noai service uninstall
```

The service runs `noai --daemon` without GTK, a display, or an open window. It starts with your user session and systemd restarts it after failure. It uses the same saved jobs as the GUI and CLI. `service install --binary /absolute/path/to/noai` selects another build; installation captures PATH for finding your existing Codex and Claude executables. Update the service installation if those paths change. No credentials or display environment are copied into the unit.

Closing or quitting the GUI leaves work running. The GUI reconnects to the daemon and replays saved output without duplicates. If no service is installed, opening the GUI can start a standalone background daemon. `service start` transfers an idle standalone daemon to systemd; it refuses to interrupt active runs. For migration from an older embedded-scheduler build, first quit that old app.

User services normally stop at logout unless lingering is already configured. Noai does not change that policy or wake a sleeping computer. Inspect logs with `journalctl --user -u noai.service`.

## Activity metrics

Activity includes an SVG line chart for total/input/output tokens or tool events, tool-frequency bars, and a harness/model breakdown. All harnesses and models are included by default; filter either and select 24 hours, 7 days, 30 days, or all recorded history. Metrics include local Codex and Claude history, even for sessions started outside Noai, plus chat and scheduled runs. A daily table shows exact totals by local calendar date.

Counters come from CLI usage events, not estimated subscription balances. Cached input is included in input totals. Cumulative session readings are differenced before filtering; an unfamiliar resumed session establishes a baseline rather than counting historical usage as new. Missing usage remains “Not reported.” Model names use the selected model or actual model when reported; unspecified models appear as “Harness default / not reported.” Tool counts represent observed tool requests/completions, not a guarantee of successful execution.

A background importer scans `~/.codex/sessions`, `~/.codex/archived_sessions`, and `~/.claude/projects` (including nested subagent logs); `CODEX_HOME` and `CLAUDE_CONFIG_DIR` overrides are supported. It reads history once, then checks file metadata every 30 seconds and reads appended bytes only. A metric-only cache, `local-metrics-v1.json`, persists file offsets across daemon restarts. Repeated Claude message snapshots and Codex cumulative counters are deduplicated; matching imported sessions replace Noai's own usage/tool counters to avoid double-counting. Missing or unreadable history is reported in Activity. Existing cached history is retained if source logs are removed. The importer never modifies agent logs.

The daemon stores event history locally in `daemon-events.jsonl` in Noai's application data directory. History currently has no automatic retention limit; it may include agent output. No external analytics service is used.

## Schedule from the command line

Start the Noai background service. The zero-dependency CLI talks to the local scheduler daemon and prints JSON, so task IDs can be used in scripts. From this checkout, run `./bin/noai`; to call it as `noai`, add this checkout's `bin` directory to your `PATH`.

```sh
./bin/noai jobs create --title "Review tests" --prompt "Review failing tests and propose fixes" --project /path/to/project --at now
./bin/noai jobs create --title "Daily review" --prompt-file /path/to/prompt.txt --project /path/to/project --at now --every 1d --auto-resume true
./bin/noai jobs create --title "Friday report" --prompt "Summarize the work" --project /path/to/project --at 2026-10-09T09:00:00-04:00
./bin/noai jobs list
./bin/noai jobs runs TASK_ID
./bin/noai jobs update-auto-resume TASK_ID true
./bin/noai jobs cancel TASK_ID
```

`--harness` accepts `codex` (the default) or `claude`; `--model` selects a model supported by the installed CLI. Omit `--project` to have Noai create a new project, or pass an existing folder. `--every` accepts seconds, minutes, hours, or days such as `90s`, `30m`, `2h`, or `1d`, with a minimum of 60 seconds. `--at` takes `now` or a future ISO-8601 timestamp with a timezone (replace the example date above when using it). `--auto-resume` defaults to `true`: when a provider reports a temporary timed limit, Noai waits and continues the run through that provider's local CLI. Updating this setting on an existing task applies to future occurrences; a running or waiting occurrence keeps its original setting. Authentication, billing, and limits without a known reset time still need attention. The app and computer must stay awake for work to launch at its scheduled time.

The CLI uses the app's Unix socket in its data directory: on Linux, `$XDG_DATA_HOME/dev.noai.desktop/control.sock` or `~/.local/share/dev.noai.desktop/control.sock`; on macOS, `~/Library/Application Support/dev.noai.desktop/control.sock`. Use `--socket PATH` if your app uses another data location. `./bin/noai help` shows all commands.

## Included in this foundation

- Light, dark, and system appearance, with neutral charcoal dark surfaces and Graphite, Sage, Blue, and Amber accents.
- Optional project folder picker; without a folder, each new chat or job gets a UUID workspace in `~/.noai`. Conversation search, rename, and delete.
- Separate Codex and Claude Code harnesses, discovered Codex models, Claude CLI aliases, harness defaults, and saved custom model IDs.
- Real native CLI execution, assistant messages as they arrive, tool activity, cancellation, and native session continuation.
- Saved conversations, per-conversation drafts, selected models, and appearance.
- Account and quota monitoring for supported providers, with data sources and honest unavailable states.
- User-set plan labels when a provider does not report the subscription tier.
- Persistent timed auto-resume, cancellation, account verification, and event recovery.
- Jobs tab for immediate, future one-time, and recurring interval runs, with cancellation and saved output history.
- System tray background operation.
- Activity view and conversation context panel.
- Keyboard controls, responsive layout, accessible native dialogs, and reduced-motion support.

Switching harnesses starts a new conversation. Existing messages and the original provider session remain available in the sidebar. Switching models retains the same harness session; the model ID must be supported by that CLI/account. Leaving the model set to **Harness default** delegates selection to the CLI configuration.

## Jobs

Open **Jobs** to choose a prompt, harness, model, optional project, and start time. Start now or pick a future local date and time. Repeat once or at an interval of minutes, hours, or days (minimum one minute). Each occurrence starts a fresh harness session in the job's saved project folder. Runs never overlap within one job. Missed occurrences coalesce into one run after reopening; the next occurrence follows the original interval. Failed or interrupted runs stop for review instead of repeating automatically. Output is available under **View history**.

The scheduler runs in a separate daemon managed by the systemd user service. Quitting the GUI does not stop it. A sleeping computer postpones work. The GUI and CLI use the same scheduler and durable records.

Every scheduled execution receives shared [unattended-job instructions](src-tauri/src/unattended-job.md) before its task text. These tell the agent to make reasonable reversible decisions, finish and verify the requested work without waiting for optional questions, preserve progress across interruptions, and leave a self-contained final report. They apply to both harnesses, existing saved jobs, manual retries, and timed usage-limit resumes; ordinary chats and stored task prompts are unchanged. Explicit task constraints and permissions still apply. This improves agent guidance but does not guarantee completion or automatically restart an agent that exits early. Rebuild and restart an idle daemon to activate changes to these instructions.

## Current execution behavior

Codex uses `codex exec --json` (and `exec resume`). New scheduled jobs default to an explicit `workspace-write` sandbox with network enabled and `approval_policy="never"`, allowing project edits and commands without interactive prompts. Chat and older saved jobs retain their existing CLI configuration. New Claude jobs use `--permission-mode auto` for automatic permission review (requires provider/account/model support). Claude chat, older jobs, and the Existing CLI settings option use `dontAsk`: actions requiring interactive approval are denied. Auto review is not an OS sandbox, and denials still apply; Noai never falls back to bypass if auto review is unavailable. The **Dangerously bypass permissions** checkbox is off by default. When enabled for a chat or job, Codex gets `--dangerously-bypass-approvals-and-sandbox`; Claude gets `--dangerously-skip-permissions` instead of `dontAsk`. This choice persists for that chat/job, including quota retries. New chats and newly selected harnesses default to normal permissions. The CLI equivalent is `--dangerously-bypass-permissions true`. Interactive approvals remain a next-stage integration.

Agent CLIs are found on PATH, then by asking your login shell (so your shell profile, active nvm/asdf version and custom installs win), then in common install locations (`~/.local/bin`, `~/.claude/local`, npm/bun/volta/pnpm/nvm/fnm directories, Homebrew, and per-OS locations). A Noai opened from Finder, the Dock or a desktop launcher therefore finds agents that only your shell profile adds to PATH. Agents run with their own directory and those locations added to PATH, so npm-installed CLIs find `node`. Set `NOAI_DATA_DIR` to run an isolated daemon, GUI and CLI against another data folder.

Messages arrive in complete assistant blocks, rather than individual token deltas. The adapters reuse native CLI authentication and do not inspect or copy account credentials. CLI discovery confirms installation, not authentication. Errors such as expired sign-in are shown in the conversation.

By default, closing the window hides Noai in the system tray. Disable this in Settings to close the window instead. **Quit Noai** quits the GUI; the daemon continues running. Use `noai service stop` to stop the systemd scheduler and its agent processes; waiting jobs remain saved. Interrupted running jobs require review after restart rather than automatic replay. No work can execute while the computer is asleep or powered off.

Automatic resume applies to new requests when enabled in Settings. It requires a confirmed timed provider limit, an explicit reset/delay, and a verifiable account identity. Native sessions continue with a continuation instruction. Unknown errors, authentication, depleted balance, account changes, and ambiguous recovery require attention. Quota retries are bounded by eight attempts and a seven-day lifetime. Cancel chat quota retries in Activity and user-created scheduled tasks in Jobs.

Codex account/model information comes from its app-server using the existing login. Claude usage depends on limit information reported by its CLI; Noai does not invent a full allowance meter when the CLI omits it. OpenRouter monitoring reads `OPENROUTER_API_KEY` from the desktop process environment and displays that key's spend limit. Gemini, Copilot, and Cursor have unavailable automatic usage adapters in this version; you can label their plans manually. See [remaining work](docs/roadmap.md).

Paid provider inference is not used in automated verification. `test/native-smoke.mjs` launches the built daemon without a display, with local fake CLIs and checks real CLI control, UUID creation, persistent scheduling, cancellation, and timed quota continuation. Browser tests use simulated IPC.

## Change the palette

Edit [`src/styles/tokens.css`](src/styles/tokens.css). It is the single location for all interface color values:

```css
:root,
:root[data-theme='light'] {
  --canvas: #f7f6f2;
  --surface: #fffefa;
  --ink: #262c28;
  --accent: #5e8065;
}

:root[data-theme='dark'] {
  --canvas: #0e0e0f;
  --surface: #171718;
  --ink: #ededee;
  --accent: #91b79a;
}
```

Semantic tokens also cover muted text, borders, focus, status colors, overlays, and shadows. Components refer to tokens, not hardcoded colors. Presets override the accent-related tokens. To introduce a new preset name, also register it in `core/theme.js`, `core/state.js`, `theme-init.js`, and the settings radios in `index.html`.

## Source layout

```text
src/
  index.html              Semantic app shell and dialogs; no inline scripts/styles
  styles/
    tokens.css            Theme colors and palette overrides
    base.css              Resets and accessibility defaults
    layout.css            Main app structure
    components.css        Chat, controls, cards, and dialogs
    responsive.css        Small-screen layouts and reduced motion
    main.css              Stylesheet imports
  js/
    theme-init.js         Tiny early theme loader to prevent theme flashing
    main.js               App orchestration and event bindings
    core/                 State schema, harness catalog, theme behavior
    services/             Native bridge, persistence, provider capabilities
    components/           DOM rendering for messages, navigation, and panels
src-tauri/
  src/adapters.rs         CLI discovery, argument building, JSONL normalization
  src/runtime.rs          Desktop IPC forwarding
  src/engine.rs           Shared run lifecycle, cancellation and scheduling
  src/daemon.rs           Headless scheduler entry point
  src/ipc.rs              Desktop client and event relay
  src/providers.rs        Account identity, model discovery, and usage adapters
  src/scheduler.rs        Locked, durable resume journal and event history
  src/scheduled_tasks.rs  User-created schedules and run history
  src/projects.rs         UUID workspace creation and folder validation
  src/control.rs          Private local socket and durable event replay
  src/storage.rs          Atomic workspace writes
  src/lib.rs              Native application setup and shutdown
  src/digest.rs           Daily digest prompt built from job history and local usage
  src/harness/            Every agent CLI, behind one `Harness` trait (nothing else names an agent)
    mod.rs                Trait, registry (`ALL`), shared token/transcript helpers
    codex.rs              Codex: argv, JSON events, permissions, models, usage, history import
    claude.rs             Claude Code: the same, for `claude --print --output-format stream-json`
  src/platform/           All OS-specific behaviour (other modules never use cfg for OS logic)
    mod.rs                Shared API: data dir, agent CLI discovery, child PATH
    unix.rs               macOS + Linux: process groups, file modes, login-shell lookup
    macos.rs              Application Support, launchd, Homebrew locations
    linux.rs              XDG data, systemd, distro/snap/flatpak locations
    windows.rs            %APPDATA%, taskkill, npm/winget locations (control socket still Unix-only)
bin/noai                  Node CLI for the running desktop app
scripts/service/          `noai service`: index.mjs picks systemd.mjs (Linux) or launchd.mjs (macOS)
AGENTS.md                 Scheduling instructions for coding agents
scripts/                  Dependency-free development server, build, checks
test/                     Core unit tests and optional browser integration check
docs/                     Architecture and staged roadmap
```

Jobs that are still **Scheduled** have an **Edit job** action. It opens the existing job form with its name, instructions, agent, model, project, next start time, recurrence, and resume settings. Saves are rejected atomically once the scheduler claims the occurrence. A recurring job can be edited again between runs; a stale editor cannot overwrite the next occurrence after a run has started. Previous runs retain their original configuration.

## Adding an agent

Noai is agent-agnostic. Each CLI is one file in `src-tauri/src/harness/` that implements the `Harness` trait:

- **Identity:** id, label, and the executable it looks for.
- **Running:** the headless arguments and how to read its JSON output.
- **Settings:** its permission modes (the default first), its read-only mode for the digest, and its bypass text.
- **Account:** model discovery, account usage and sign-in identity.
- **History (optional):** where its session transcripts live and how to read them.

Add the new type to `ALL` in `harness/mod.rs`. The app reads everything from that registry through `runtime_status`: agent pickers, permission menus, the Sessions filter, provider cards, history import, metrics and the digest. No frontend change is needed. The registry test checks that every agent is complete.

## Daily digest

Open **Digest** to turn on a daily report. Choose a time, an agent and a model, the same way as for a job. Each day the daemon gathers the last 24 hours of job runs (status, duration, tokens, tool use, errors, usage-limit waits), jobs needing attention, upcoming runs and local Codex/Claude usage, and puts that data in the digest's prompt. The agent replies with a Markdown report: needs attention, a per-job table, usage and a few insights. **Write one now** runs it immediately without moving the daily time. A failed digest does not stop tomorrow's. The digest runs read-only (Codex `read-only`, Claude `dontAsk`) in `~/.noai/digest`, uses a small amount of the chosen agent's allowance, and is kept out of the Jobs list. Its schedule is a fixed 24-hour interval from the chosen time, so it shifts by an hour across daylight-saving changes until calendar recurrence ships.

## Local sessions

The **Sessions** tab lists local Codex and Claude histories, archived Codex sessions, and saved Noai conversations. It honors `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, includes nested Claude histories, and does not edit source files. Search by title, project, model, or session ID; filter by agent and sort by update time or name. The table shows 25 sessions per page.

Open a row for a separate session page with its conversation, model, project, timestamps, token usage, and tool activity. Long transcripts load 100 messages at a time. Session usage is read from that file, rather than mixing it with other sessions. Unreported stats remain marked as unavailable. The initial history scan is cached in memory; Refresh checks for changed files.

## Verify and build

```sh
npm run check
npm test
npm run build
npm run rust:test
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo tauri build --debug --no-bundle
```

The debug executable is `src-tauri/target/debug/noai`. `npm run desktop:build` produces a release build using Tauri.

Optional browser tests use Playwright as an external development tool, not an application dependency. Start `npm run dev`, install Playwright and Chromium in a development environment, then run:

```sh
NOAI_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/browser.mjs
```

Screenshots are written to `/tmp/noai-check/`. The browser test covers appearance persistence, narrow screens, navigation, custom models, safe message rendering, simulated native session continuation, stop, drafts, and conversation actions.

After building the debug desktop app, `node test/native-smoke.mjs` checks native scheduling with fake agent executables in a temporary app-data directory. It requires local sockets, removes display variables, creates and removes one empty UUID workspace, and spends no provider tokens.

## Per-job permissions

Create or edit a scheduled job using **Job permissions**, or pass `--permissions` to `jobs create`:

| Agent | Mode | Behavior |
| --- | --- | --- |
| Codex | `workspace-network` (new-job default) | Project writes and shell commands, network enabled, sandbox retained, no interactive approvals |
| Codex | `workspace-write` | Same project access, shell network disabled |
| Codex | `read-only` | Read-only sandbox, no interactive approvals |
| Codex | `provider-default` | Existing CLI settings, normally read-only for exec |
| Claude | `auto-review` (new-job default) | Provider automatic tool permission review |
| Claude | `provider-default` | Configured permission rules with `dontAsk` |

The selected mode is saved with the job, each run, and quota resumes. Existing saved jobs and waiting runs are not migrated; edit a pending job to opt into a different mode. Job details show the run’s original mode. Bypass remains a separate explicit opt-in and overrides the selected mode; none of the new defaults sends a dangerous bypass flag. Codex project modes can still be restricted by administrator policy and protected paths. They do not grant unrestricted host filesystem access or guarantee access to desktop/Flatpak services or local sockets.

Example: `./bin/noai jobs create --title "Build" --prompt "Build and test this project" --project /path/to/project --permissions workspace-network --at now`.

References: [Codex permissions](https://learn.chatgpt.com/docs/agent-approvals-security), [Claude permission modes](https://code.claude.com/docs/en/permission-modes).

Timed usage limits resume **60 seconds after** the stated reset, including relative delays, structured reset timestamps, and Codex’s local `try again at 3:23 PM` messages. Time-only messages use the host timezone and the next matching local time; unknown timezone/date suffixes and ambiguous daylight-saving times are rejected. An explicit billing/authentication failure still requires attention.

Failed, paused, and cancelled jobs offer **Retry job** on their card and latest-run detail page. The CLI equivalent is `./bin/noai jobs retry TASK_ID` (optional `--at ISO-8601`). A retry queues a new attempt on the same job at least one minute from now, or later if a recorded reset requires it. It continues the saved provider session when available, preserving the prior attempt and its events; without a session, it starts a fresh conversation. Duplicate/stale retries, successful jobs, and jobs with active or waiting work are rejected. A queued retry survives restart and retains permissions. Retrying is explicit: historical blocked jobs are not silently replayed after an upgrade.
