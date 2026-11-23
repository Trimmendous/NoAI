# Plans, limits and notifications

## Your plans

The **Dashboard** shows each subscription Noai can read (Claude Code, Codex…) with its usage limits:

- **The bar** is how much of the limit is used; it turns orange, then red, as it fills.
- **The dark marker** is how far through the window you are. A bar past the marker means you're using it faster than time is passing.
- **Resets in…** counts down live. Once a window resets it shows **0%** until you use the agent again.

**Accounts** has the full detail.

## Usage budget

**Settings → Automation → Usage budget** keeps part of each limit for you. With "keep 30%", scheduled jobs only start while every limit of their agent is under 70% used; otherwise they wait for the reset. Running jobs are never stopped.

## Notifications

Noai tells you, through your system's notifications, when a job finishes, needs you, waits for a reset, or is held by your budget. Each can be turned off in **Settings → Automation**.

## Sleep

Your computer stays awake while a job runs. **Wake the computer for scheduled jobs** (Settings → Automation) also wakes it a minute before the next job; on macOS and Linux this asks for your password once.
