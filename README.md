# Noai

A calm little desktop app for working with coding agents like Codex and Claude Code. Chat with them, schedule jobs that run while you're away, and see what they've been up to. Everything stays on your machine.

It's built with Tauri, Rust and plain HTML/CSS/JS: no frameworks, no tracking.

## What it does

- **Chat** with whichever agent you have installed. Noai finds them for you. Open several chats as tabs, split the window into as many panes as you like, or drag a chat out into its own window.
- **Jobs**: tell an agent to do something now, later, or every day. Closing the window doesn't stop them.
- **Auto-resume**: if an agent hits its usage limit, Noai waits for the reset and picks up where it left off.
- **Sessions**: every past conversation in one list, including ones you started outside Noai. Each one shows how full its context got and how many tokens it used.
- **Dashboard and Activity**: charts of your token use, tool calls and errors over time.
- **Models**: every agent on your computer and the models it can use, drawn as a little graph.
- **Accounts**: how much of your Claude or Codex quota you have left.
- **Daily digest**: a short morning report on what ran, what broke and what needs you.
- **Plugins**: add your own pages, ⌘K commands, themes and even new agents. See [PLUGINS.md](PLUGINS.md).
- **Accessibility**: a text size slider, colour-blind-friendly modes, more contrast and less motion, all in Settings.

## Getting started

You'll need Node 22+, Rust and the Tauri CLI (`cargo install tauri-cli --version '^2'`). You'll also need at least one agent CLI (Codex or Claude Code) installed and signed in.

```sh
npm run desktop
```

That's it. Want to poke at the UI in a browser instead? Run `npm run dev` and open http://127.0.0.1:1420. It can't talk to your agents from there, though.

## Keep it running in the background

To have jobs run even when the app is closed, install the background service:

```sh
./bin/noai service install
./bin/noai service start
```

It works on macOS and Linux and starts automatically when you log in. Your computer still needs to be awake for jobs to run.

## Schedule from the terminal

```sh
./bin/noai jobs create --title "Review tests" --prompt "Look at the failing tests" --at now
./bin/noai jobs create --title "Daily check" --prompt "Review open work" --every 1d
./bin/noai jobs list
```

Run `./bin/noai help` for everything else.

## A note on permissions

Jobs run with sensible, sandboxed permissions by default. There's a **Dangerously bypass permissions** switch if you really want the agent to have free rein. It's off unless you turn it on.

## Hacking on it

`npm test` and `npm run check` cover the basics. The technical notes are in [AGENTS.md](AGENTS.md): code layout, how to add a new agent, permission modes and the full test list. They're written for coding agents, but humans are welcome too.
