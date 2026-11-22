# Writing Noai plugins

A plugin is a folder in `~/.noai/plugins/<id>/` with a `plugin.json`. It can add:

- **Pages** to the sidebar (plain HTML/JS, shown in a sandbox)
- **Commands** to the ⌘K palette, and reactions to events
- **Themes** next to Light, Dark and Matrix
- **Agents**: another coding-agent CLI Noai can chat with and run jobs on

Plugins are off until you turn them on in **Settings › Plugins**, which also lists exactly what each one is allowed to do. The quickest start: press **Create example plugin** there, turn on "Hello Noai", and read its files (they're also in `examples/plugins/hello-noai/` in this repo).

## plugin.json

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "One sentence about what it does.",
  "author": "You",
  "permissions": ["chats:read", "notify"],
  "pages": [{ "id": "main", "title": "My page", "icon": "M", "entry": "page.html" }],
  "main": "main.js",
  "commands": [{ "id": "do-thing", "title": "Do the thing", "context": "chat" }],
  "themes": [{ "id": "mine", "name": "Mine", "base": "dark", "colors": { "--canvas": "#101820", "--accent": "#f2aa4c" } }],
  "agents": [{ "id": "mycli", "label": "My CLI", "command": "mycli", "args": ["--print"], "modelArgs": ["--model", "{model}"], "models": ["fast", "smart"], "output": "text" }]
}
```

- `id`: lowercase letters, digits and dashes, and the same as the folder name.
- Paths (`entry`, `main`) are relative to the plugin folder and can't leave it.

## Permissions

| Permission | Lets the plugin |
|---|---|
| `chats:read` | list and read chats; hear `chat.finished` |
| `chats:write` | start agent runs (`noai.chats.send`) |
| `jobs:read` | list jobs and their runs; hear `job.finished` |
| `metrics:read` | read usage totals |
| `notify` | show notifications |
| `network` | make `https:` requests from its pages (otherwise all network access is blocked) |

## Pages and the background script

Pages and the background script (`main`) run in sandboxed frames served from `noaiplugin://`. They can't reach Noai's data, your files or the network, except through the `noai` API below. Load the SDK (and, optionally, styles that match Noai) in your page:

```html
<link rel="stylesheet" href="../_sdk/noai.css" />
<script src="../_sdk/noai.js"></script>
```

The background script gets the SDK automatically.

Each page is one document. The SDK gets a private connection to Noai once, when the page first loads it. If the frame then loads any other page, by following a link, submitting a form or being redirected, Noai cuts it off and reloads your page. A page that keeps doing this is stopped. Switch views inside the page instead of navigating to another file. Inside any of them:

```js
await noai.chats.list()               // [{ id, title, harness, model, messageCount, running, … }]   chats:read
await noai.chats.get(id)              // { id, title, messages: [{ role, content, createdAt }] }      chats:read
await noai.chats.open(id)             // shows the chat
await noai.chats.send({ prompt, chatId?, harness?, model? })  // starts a run → { chatId }       chats:write
await noai.jobs.list()                // [{ id, title, status, nextRunAt, … }]                       jobs:read
await noai.jobs.runs(jobId)           // [{ runId, status, startedAt, finishedAt, result }]          jobs:read
await noai.metrics.summary('7d')      // { tokens, cacheRate, cost, sessions, toolEvents, calls }     metrics:read
await noai.notify('Done!', 'info')    // or 'error'                                                  notify
await noai.storage.set('key', value)  // small per-plugin storage (256 KB)
await noai.storage.get('key')

noai.on('chat.finished', ({ chatId, error, stopped }) => {})        // chats:read
noai.on('job.finished', ({ jobId, title, status, result }) => {})   // jobs:read
noai.onCommand('do-thing', async ({ chatId }) => { /* ⌘K command */ })
```

Pages receive Noai's colours as `--noai-canvas`, `--noai-surface`, `--noai-ink`, `--noai-ink-muted`, `--noai-line`, `--noai-accent`, … and `data-theme` on `<html>`, updated when the user changes theme.

## Commands

Each command in `commands` appears in the ⌘K palette and calls the `noai.onCommand` handler in your background script. With `"context": "chat"`, it only shows while a chat is open, and the handler gets `{ chatId }`.

## Themes

An optional `subtitle` (up to 40 characters) shows under the theme's name. `base` is `light` or `dark` (all of that mode's rules still apply). Add `"background": "flags/in.svg"`, a picture from your plugin's folder, and optionally `"backgroundOpacity"` (0.05–0.6, default 0.3), to show it faintly behind the whole app. Give the surfaces see-through colours (`rgba(…)`) so it shows. The World flags plugin in `examples/plugins/world-flags/` does this. `colors` overrides any of Noai's colour variables, such as `--canvas`, `--surface`, `--surface-subtle`, `--sidebar`, `--topbar`, `--ink`, `--ink-soft`, `--ink-muted`, `--line`, `--accent`, `--accent-soft` and `--accent-ink`. Values must be plain colours: no `url()`.

## Agents

An agent teaches Noai to drive another CLI. Its id becomes `plugin-<id>`, and it appears wherever the built-in agents do: chat, jobs and Models.

- `command`: the program's name, found on your PATH like Claude Code and Codex. It can't be a path.
- The prompt is written to the program's **stdin**.
- `args`: always passed. `{project}` becomes the project folder and `{model}` the chosen model.
- `modelArgs`: added only when a model is chosen.
- `models`: listed in the model picker. You can still type any model ID.
- `output`: `"text"` means every printed line is part of the reply. `"jsonl"` means each line is JSON and the reply text is in `textField` (default `"text"`).

Plugin agents don't report usage or sign-in status, and have no permission bypass. Noai runs the command as described, so whatever that CLI is allowed to do on your computer, it can do. Only turn on agents from plugins you trust.

The example plugin's **Echo** agent runs `cat`, so it replies with exactly what you send. That's handy for checking the plumbing.
