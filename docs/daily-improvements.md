# Daily Noai improvement log

Use [roadmap.md](roadmap.md#daily-improvement-backlog) for priorities; append results here rather than creating another tracker. Earlier work is documented in ui-readability.md, ui-analytics.md and HANDOFF.md.

## 2026-10-14 — Safe first-job practice

Problem: first-time users lacked an in-app explanation connecting desktop jobs to CLI usage and could only exercise CLI creation by submitting real work.

Changed:
- `bin/noai`: `jobs create --dry-run true` validates ordinary creation options and prints `{dryRun:true, validation:"cli-options-only", request:...}`. No socket connection, project creation or agent launch occurs. False/omitted retains normal creation. Help includes a runnable example and the fixed-interval DST limitation.
- `src/index.html`, `src/styles/surfaces.css`: collapsible, reopenable Jobs guide explains account prerequisites, task/project selection, safe CLI practice, real creation, history/conversation access and recovery. No live tutorial run or automatic form submission.
- `test/cli.test.js`: option validation, boolean opt-in, duplicate flags, prompt files, no-daemon operation and no project-directory creation.
- `test/browser/jobs.mjs`: guide expansion/collapse and overflow checks in four theme/viewport combinations; optional NOAI_CHROMIUM selects an already-installed executable.

Validation: `npm run check`; all 44 `npm test` tests; fixture browser workflow suite (completed/historical/missing history, navigation, guide, responsive layouts); CLI help/example execution. Inspected guide screenshots at 1280 and 390 pixels in light/dark themes under `/tmp/noai-first-job`. Desktop release build produced `src-tauri/target/release/noai`; existing STATIC_VCRUNTIME deprecation warning remains. No Rust logic changed. Browser tests use synthetic IPC, not live accounts or native WebKit; no paid inference was tested.

Limits: guide is instructional, not an interactive simulation. Dry run validates CLI syntax/options, not provider readiness, filesystem suitability or server acceptance; its JSON includes the supplied prompt. Calendar recurrence and migration are not implemented. Existing daily job `task-336222-1791925352025080311-83` was running this exact prompt with intervalSeconds 86400; no duplicate job was created and no schedules changed. No other scheduled run was active in the inspected job list. The sandbox exposes an empty `.git`, so Git status/diff is unavailable; changes were limited to inspected files without resetting earlier work.

Activation: CLI works immediately from this checkout. Reopen the GUI using the rebuilt binary for the new guide. No daemon restart is required. Only the preview process started for this occurrence was stopped. Next: calendar recurrence with safe migration as described in the backlog, then interactive onboarding/provider diagnostics.


## 2026-10-14 — In-conversation rerun: sample walkthrough

Problem: the first-job guide was static and its safe CLI example required manual selection.

Changed: `src/js/components/job-guide.js`, `src/index.html` and `src/styles/surfaces.css` add an explicitly labeled, three-step sample review/result/conversation walkthrough. Previous, skip, finish and replay controls preserve real job fields and return keyboard focus. The module uses built-in sample text and no IPC. A safe CLI copy action reports success or clipboard failure without executing the command. `test/browser/jobs.mjs` covers these paths alongside existing job/history navigation, in both themes at desktop and narrow widths.

Validation: syntax/HTML checks; all 44 unit/CLI tests; Chromium fixture browser suite; visual inspection of all four walkthrough theme/width screenshots in `/tmp/noai-walkthrough`; execution of the displayed CLI dry-run example. `cargo tauri build` succeeded and produced `src-tauri/target/release/noai` (existing STATIC_VCRUNTIME deprecation warning). Sandbox restrictions required approved socket/browser execution. No Rust logic changed. Browser tests mock clipboard and IPC; native WebKit clipboard behavior and live provider inference were not tested.

Limits: walkthrough is an instructional sample, not an editable job simulator. CLI behavior remains the existing validated dry-run command. Calendar recurrence/migration remains pending. No scheduled jobs were launched or modified and the daemon was not restarted. Git metadata is unavailable in this workspace. Temporary preview was stopped after verification.

Activation: reopen the rebuilt desktop app to see the walkthrough. Next: timezone-aware daily recurrence and provider diagnostics, with editable tutorial inputs as a smaller follow-up.

## 2026-10-15 — Editable safe CLI practice

Problem: onboarding offered a fixed command, and CLI dry-run JSON was harder for first-time users to review.

Changed: `src/index.html`, `src/js/components/job-guide.js`, new `job-guide-command.js`, and `src/styles/surfaces.css` add editable title/prompt/project practice fields, inline validation and a copyable POSIX-shell command. Empty project previews new-folder behavior. Inputs affect only the local example, never real job fields or IPC. Shell quoting preserves literal apostrophes, substitutions and spaces. The example rejects control characters, multiline values and CLI option-like values. `bin/noai` adds opt-in `--format text` for dry runs, showing project, permissions, schedule and validation boundaries; default JSON remains unchanged. Format flags without dry-run mode are rejected to avoid accidentally submitting a preview.

Validation: syntax/HTML checks and all 47 unit/CLI tests passed, including executing generated commands through /bin/sh and checking literal values in JSON. CLI help and readable example executed successfully. Expanded fixture browser suite passed in desktop/narrow light/dark layouts; inspected screenshots under `/tmp/noai-editable-practice`. Playwright's default executable was missing and full Chromium failed crashpad initialization; the installed Chromium headless shell ran successfully. `npm run desktop:build` succeeded, producing `src-tauri/target/release/noai`; existing STATIC_VCRUNTIME deprecation warning remains. No Rust logic changed. Native WebKit clipboard and live inference were not tested.

Limits: practice remains Codex/read-only and single-line, with a separate fixed sample walkthrough. Previews do not validate credentials, project access or server acceptance. Calendar recurrence and migration remain pending; task `task-336222-1791925352025080311-83` was the only running scheduled task in the inspected list. No duplicate schedule, schedule changes, daemon restart or unrelated launches. Git metadata remains unavailable. Only this occurrence's preview server was stopped.

Activation: CLI changes work immediately; reopen the rebuilt desktop app for the practice fields. Next priorities: timezone-aware daily recurrence with safe migration, then provider diagnostics. Keep native browser validation as a remaining coverage gap.

## 2026-10-21 — Resume: reject silently shifted schedule times

Inspected AGENTS.md, prior completed notes, current CLI/code and active jobs. The October 15 onboarding increment was complete and was preserved. This improvement job was active; the other active job used a separate project. Git metadata remains unavailable in this sandbox.

Problem: JavaScript Date parsing silently rolls impossible calendar dates forward and shifts nonexistent spring-forward local times. A user could submit a different schedule than intended.

Changed: new shared `src/js/core/schedule-time.js` validates calendar fields and timezone offsets. `bin/noai` uses it for create (including previews) and retry timestamps; invalid dates fail before connecting to the daemon. `src/js/components/scheduled-tasks.js` uses local-time validation for both create/edit submission, rejects DST gaps before project creation or IPC and restores focus to the time field. `src/index.html` explains repeated-hour behavior: desktop selects the first occurrence; CLI explicit offsets can select either. CLI help documents this. No scheduler state, recurrence algorithm, histories or permissions changed.

Validation: `npm run check`; all 50 JavaScript/CLI tests; all 7 native scheduled_tasks tests (history, stale edits/claim cutoff, recurring claims, cancellation, retries and saved-session/reset behavior). New tests cover leap dates, invalid dates/hours/offsets, fractional seconds, New York DST gap and both repeated-hour offsets. Browser fixture suite passed with America/New_York emulation and verified gap rejection with zero mutation calls in four theme/viewport combinations; inspected desktop/narrow light/dark screenshots in `/tmp/noai-date-validation`. CLI help and a second-occurrence dry-run example produced the expected 06:30 UTC timestamp. Desktop build result recorded below.

Limits: this is input validation, not timezone-aware daily recurrence. The 00:01 America/New_York recurrence and authorized migration remain pending. Native WebKit date-picker behavior and live provider inference were not tested; browser checks used the installed Chromium headless shell with synthetic IPC. Existing native tests cover unchanged scheduler safety; no new backend scheduling behavior was introduced. CLI timestamps use explicit offsets, not named zones. Desktop repeated-hour selection remains first occurrence with documented CLI recovery.

Activation: CLI changes apply immediately; reopen the rebuilt desktop app for form validation/help. Do not restart the active daemon. No schedules, unrelated jobs or services were modified. Next: implement calendar daily recurrence end to end with DST policy and safe capability-checked migration, then provider diagnostics.

Build/cleanup: `npm run desktop:build` succeeded and produced `src-tauri/target/release/noai`, with the existing STATIC_VCRUNTIME deprecation warning. Stopped only this occurrence's preview server on port 1461.
