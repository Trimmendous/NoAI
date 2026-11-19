# Working with Noai

When a user asks you to schedule work in Noai, use the local `bin/noai` CLI. It talks to the running Noai app or Linux user service. Run `bin/noai help` for syntax. Pass `--project` when the user names an existing folder; omit it when asking Noai to create a new project. Quote prompts or put long prompts in a file and pass `--prompt-file`.

Examples (run from this repository):

```sh
./bin/noai jobs create --title "Review tests" --prompt "Review failing tests" --project /path/to/project --at now
./bin/noai jobs create --title "Morning review" --prompt-file /path/to/prompt.txt --at 2026-10-09T09:00:00-04:00
./bin/noai jobs create --title "Daily review" --prompt "Review open work" --every 1d --auto-resume true
./bin/noai jobs list
./bin/noai jobs runs TASK_ID
./bin/noai jobs cancel TASK_ID
```

Set `--auto-resume true` when creating tasks that should continue after a temporary, timed Codex or Claude usage limit. This is the default. For an existing scheduled task, run `./bin/noai jobs update-auto-resume TASK_ID true`. That change applies to future occurrences; an already running or waiting occurrence keeps its original setting. Noai resumes only when the provider gives a retry time and the local CLI can continue the run. A billing, authentication, or non-timed failure needs user attention. Do not promise automatic access to paid inference or bypassing a provider's limits.

For a one-time task use `--at now` or an ISO-8601 timestamp with timezone. For a repeating task add `--every` (minimum 60 seconds). Confirm the created task ID and schedule from the JSON output. Use `jobs list`, `jobs runs ID`, and `jobs cancel ID` to inspect or manage it. Keep the Noai daemon or systemd user service running for scheduled launches and resumes; the window can be closed.

On Linux, `./bin/noai service install` writes and enables a systemd user service for the local Noai binary; on macOS it writes a launchd LaunchAgent (`~/Library/LaunchAgents/dev.noai.daemon.plist`); `service start`, `stop`, `status`, and `uninstall` manage it. Pass `service install --binary /absolute/path/to/noai` for another build. The service runs in the user's login session by default. Do not enable lingering without the user's explicit request. For migration, quit any old embedded-scheduler app. `service start` transfers an idle standalone daemon automatically and refuses to interrupt active runs. New GUI windows are daemon clients and can coexist with the service.

New Codex jobs default to `--permissions workspace-network`: sandboxed project writes and network access without interactive approvals. Choose `workspace-write` for offline commands, `read-only` for inspection, or `provider-default` for existing CLI behavior. New Claude jobs default to `auto-review` (provider permission review); `provider-default` keeps `dontAsk` behavior. Modes are saved per job and run, including timed resumes. Existing jobs keep their saved settings; do not assume a rebuilt service changes old jobs. `--dangerously-bypass-permissions true` is an explicit opt-in per job for unattended tool access; use it only when the user has specifically authorized that access for the task. The option works with both Codex and Claude harnesses.

Automatic timed retries wait 60 seconds after the provider reset. `jobs retry ID [--at ISO-8601]` explicitly queues a failed, paused or cancelled job at least one minute from now, and never before a known reset plus the grace period. It keeps previous run history and continues the saved provider session when available. Use it when the user wants that job continued; successful, active, waiting and already-scheduled jobs cannot be retried.
