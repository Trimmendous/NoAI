# Noai implementation and remaining work

## Implemented

- Independent Tauri app with modular vanilla HTML/CSS/JavaScript.
- Centralized light/dark palette tokens and appearance preferences.
- Codex/Claude subprocess chat, cancellation, session continuation, models, saved chats and drafts.
- Provider interface: Codex app-server data, Claude sign-in and emitted limit telemetry, OpenRouter key usage where configured.
- Unavailable states and user-set plan labels for other providers.
- Timed-resume journal with single-process ownership, atomic writes, account checks, bounded attempts, cancellation, and event recovery.
- Waiting-work interface and system tray background mode.
- Neutral dark surfaces and a Graphite accent preset.
- Automatic UUID project folders under `~/.noai`.
- Persistent Jobs tab for immediate, future, and recurring work; full output history.
- Local CLI for scheduling, service management and auto-resume configuration, with agent instructions in AGENTS.md.
- Headless scheduler and systemd user service; GUI and CLI share one execution owner.
- Explicit per-chat/job permission bypass for both harnesses, default off.

## Coverage boundaries

- Gemini CLI runs as an agent but reports no account quota; Copilot and Cursor usage readers remain unsupported. No inferred quotas are shown.
- An explicit reset and verified account are necessary for automatic resume. Time-only messages without a timezone and unclassified errors are insufficient.
- Interactive tool approvals cannot be answered in Noai yet. Claude headless mode denies those requests; Codex retains its configured policy.
- The systemd user service runs independently of the GUI. Logout behavior follows the system user-manager policy; Noai does not enable lingering or wake the computer.
- Provider inference is not part of automated testing. Tests use protocol and process fixtures instead of spending allowance.

## Next extensions

1. Bidirectional harness transports for interactive approvals and token deltas.
2. Additional provider adapters based on documented, account-scoped APIs.
3. Explicit account/profile selection, including organization-specific billing identities.
4. Event-journal compaction and import/export for long-running installations.
5. Import/export, richer tool diffs, and model capability metadata.

## Verification

Use controllable timestamps and synthetic provider fixtures for limits. Cover claim/cancel races, partial execution, missed UI events, account changes, restart while waiting versus running, and duplicate suppression. Keep browser IPC fixtures distinct from native protocol/process tests.

## Daily improvement backlog

Daily occurrence notes: [daily-improvements.md](daily-improvements.md). Keep this as the single prioritized backlog for the desktop/CLI maintenance job.

1. Implement timezone-aware local-calendar daily recurrence in desktop, CLI and scheduler. Test DST, invalid/ambiguous local times, immutable history, stale edits and duplicate claims. Then migrate only task `task-336222-1791925352025080311-83` to 00:01 America/New_York, preserving history. The current daemon has only fixed intervals; do not restart an active daemon or edit its persisted state behind it. Migration remains pending. Strict calendar/offset validation and desktop DST-gap rejection shipped on October 21; this validates individual start times and does not implement calendar recurrence.
2. Editable Codex/read-only practice fields, safely quoted CLI commands and readable offline previews are implemented. The replayable sample walkthrough remains separate and uses fixed teaching text. Future onboarding work should prioritize provider readiness and native WebKit verification rather than more sample-only UI.
3. Improve provider setup/status and matching CLI diagnostics using verified prerequisites; distinguish installed, authenticated and runnable without spending allowance or changing credentials.
4. Add human-readable CLI metrics summaries with stable JSON and explicit missing-data/cost coverage semantics.
5. Continue orchestration usability and readability while retaining completed/historical conversations and the current Jobs arrangement.
