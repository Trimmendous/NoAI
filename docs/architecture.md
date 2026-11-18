# Noai architecture

Noai is a new application, not a Jean fork. The frontend consists of native browser modules. The separate headless daemon owns CLI process execution and schedules. The Tauri desktop is a client; it stores the UI workspace and provides native windows and folder selection.

## Boundaries

1. `index.html` owns static structure, controls, and native dialogs. No event handlers or CSS are embedded in HTML.
2. `styles/tokens.css` owns colors. Layout, components, responsive rules, and base styling live in separate files.
3. `core/state.js` owns the versioned workspace schema, constructors, normalization, and immutable store snapshots.
4. `components/` renders state using DOM methods and `textContent`. Agent output is never inserted as raw HTML. Fenced code blocks are parsed into safe DOM nodes.
5. `services/bridge.js` is the only frontend IPC boundary. Browser mode explicitly exposes unavailable native capabilities.
6. `services/workspace.js` serializes debounced saves, drains pending writes, and retains failed saves for a later flush. Failed initial loads block writes rather than silently overwriting a saved workspace.
7. `main.js` coordinates view state, run events, and user actions. It does not spawn processes or handle credentials.
8. Rust's runtime enforces one active run per conversation. Each Unix CLI receives its own process group. Stop/app shutdown terminate the owned process group.
9. `scheduler.rs` owns timed resume jobs and their event journal. The daemon holds an exclusive journal lock. State transitions use copy-on-write candidates and atomic file replacement; memory is committed only after the write succeeds. This single-owner journal replaces the initially proposed SQLite dependency. systemd runs the same headless engine without initializing GTK.
10. `providers.rs` obtains metadata through supported CLIs/APIs. Automatic resume verifies the account before the initial launch and before retrying.

11. `scheduled_tasks.rs` persists user-created schedules and per-occurrence output; it uses the existing application lock. `control.rs` serves CLI requests through a user-only Unix socket. Both CLI and GUI call the same runtime commands.
12. `projects.rs` validates chosen folders or creates a new UUID folder under `~/.noai`. Generated folders are retained for the conversation/job lifetime and are not automatically deleted.

## Persistence

Schema version 1 stores conversations, messages, project paths, drafts, native session IDs, chosen models, and preferences. The desktop saves `workspace.json` in Tauri's `dev.noai.desktop` application data directory. Writes use a temporary file, sync, then rename. Browser preview storage is isolated under `noai.workspace.v1`.

Appearance is also cached as `noai.appearance` so the standalone early script can set data attributes before CSS loads. The persistent workspace remains authoritative after startup.

Live state is not treated as durable execution. Saved streaming/running statuses normalize to `interrupted` on startup, then scheduled-job records reconcile them. Waiting jobs recover their schedule; jobs that were running during a crash become `needs_attention`. There is no blind replay of potentially side-effecting agent work.

Scheduled runs retain ordered events with increasing `eventId`. The frontend saves its last observed ID and reconstructs scheduled assistant output from the journal. Replay replaces accumulated output instead of appending it twice. Older snapshots cannot overwrite newer live output.

## IPC contract

All API fields use camelCase.

| Command | Input | Output |
|---|---|---|
| `runtime_status` | none | `{platform, harnesses:[{id,label,installed,version?,path?,detail?}]}` |
| `load_workspace` | none | Workspace JSON or null |
| `save_workspace` | `{workspace}` | void |
| `choose_project` | none | Canonical folder path or null |
| `ensure_project` | `{projectPath: string|null}` | Canonical path, creating a UUID folder when omitted |
| `list_scheduled_tasks` | none | User-created task records |
| `create_scheduled_task` | `{input:{title,prompt,harness,model,projectPath,startAt,intervalSeconds,autoResume}}` | Task |
| `cancel_scheduled_task` | `{id}` | void |
| `get_scheduled_task_runs` | `{id}` | Run history including output events |
| `set_scheduled_task_auto_resume` | `{id,enabled}` | Updated task; future occurrences only |
| `start_run` | `{request:{runId,conversationId,harness,model,projectPath,prompt,resumeId}}` | void after process starts |
| `cancel_run` | `{runId}` | void |
| `get_provider_usage` | none | Provider snapshots with provenance and optional quota windows |
| `get_harness_models` | `{harness}` | Available model IDs and labels |
| `get_resume_jobs` | none | Resume jobs and persisted events |
| `cancel_resume_job` | `{jobId}` | void |
| `set_background_mode` | `{enabled}` | void |

`noai:run` events contain `{runId,conversationId,type,text?,resumeId?,retryAt?,eventId?}`. Types include `session`, `text`, `activity`, `usage`, `waiting`, `resumed`, `error`, and `done`. `text` is a completed assistant block to append once. Terminal `error` and `done` events follow subprocess exit and removal from active-run registration. Unknown run IDs trigger journal reconciliation. `start_run.request.autoResume` controls timed resume for that request.

## Extending harnesses

Add the native adapter, declare its capabilities, add the frontend catalog entry, and test protocol fixtures before enabling it in the selector. Do not equate an executable found on PATH with a logged-in account. Do not synthesize provider quota from local tokens.

Model selections default to the harness configuration. Codex models are discovered through its app-server catalog. Claude aliases defer version choice to its CLI. Custom IDs are user-provided and validated by the provider.

Interactive permissions require a bidirectional agent transport; the initial print/exec adapters are deliberately not presented as having an approval UI.

## Daemon transport and replay

`noai --daemon` starts Tokio, opens the journals and a private local socket, and handles SIGTERM/SIGINT by cancelling its owned process groups. The systemd user unit uses `KillMode=control-group` as an additional shutdown guarantee. Desktop commands forward to the daemon. `connect_events` begins replay only after frontend listeners are ready; `get_active_runs` restores in-flight chat controls. Per-run event IDs prevent replay duplicates.

`daemon-events.jsonl` persists socket events before delivery, including terminal event IDs. Complete lines recover across daemon restarts; an incomplete final line is discarded. The current implementation retains the full journal; compaction is a future optimization. Scheduled run histories and resume journals remain authoritative for task recovery. The GUI can quit without terminating the daemon.
