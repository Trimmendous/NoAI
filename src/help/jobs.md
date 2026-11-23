# Jobs

A job is work you hand to an agent: **now**, **at a set time**, or **repeating** (every few hours, every day…). Jobs are run by Noai's background service, so they keep going when the window is closed.

## Creating a job

Open **Jobs → New job** and give it a title, what to do, an agent, and a folder.

- **Work on a separate copy (git worktree)**: the job works on its own git branch and never touches your folder. Its changes wait in **Changes**. Recommended for anything that edits code.
- **Automatically resume**: if the agent hits a usage limit, the job waits for the reset and carries on.
- **Job permissions**: what the agent may do without asking. *Automatic permission review* (Claude) and *workspace* modes (Codex) work in any folder.

## While it runs and after

Open a job to see every run, numbered, newest first. Click a run to read its conversation.

- **Pause / Resume**: a paused job doesn't start again until you resume it; missed runs are skipped.
- **Edit**: change the prompt, agent, model, schedule or permissions. A run in progress finishes with the old settings.
- **Retry** a failed run, or **Run again** a finished one-off job.

## Instructions for every job

**Settings → Job instructions** adds text to the start of every run, for example "Never push to main". There's one box for repeating jobs and one for one-time jobs.

## SUMMARY.md log

Repeating jobs keep a log in **SUMMARY.md** in the folder they work in. Each run adds a row to a table (run number, date, and what was done in plain words), then a short section with a few more details. Open any run to read it at the top. Turn it off in **Settings → Job instructions**.
