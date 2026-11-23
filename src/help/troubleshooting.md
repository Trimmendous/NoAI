# Troubleshooting

## A job finishes in seconds without doing anything

The agent was probably refused permission. Open the job's latest run and read its last message. Common causes:

- **Claude ignored the folder's settings** because the folder isn't trusted yet. Run `claude` once in that folder in your terminal and accept the trust prompt, or set the job's permissions to *Automatic permission review*.
- **Permissions too strict** for what the job needs. Edit the job and choose a mode that allows editing.

## A job didn't start on time

- Your **usage budget** may be holding it; the job says so and starts after the limit resets.
- It may be **paused**. Open it and press **Resume**.
- The computer was asleep. Turn on **Wake the computer for scheduled jobs** in Settings → Automation.

## Logos or an agent are missing

Open **Accounts** and press **Refresh**. If an agent shows "Not installed", install its command-line tool and sign in, then refresh.

## Noai seems out of date after an update

Noai's background service keeps running when you close the window. Quit and reopen Noai: it restarts the service on the new version as soon as no job is running.

## A plugin won't turn on

**Settings → Plugins** shows a red "Can't load" label with the reason, usually a mistake in its `plugin.json`.

## Still stuck?

Use **Report a problem** at the top of this page to open an issue, and include what you were doing and what you saw.
