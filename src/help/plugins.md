# Plugins

Plugins add things to Noai: **pages** in the sidebar, **commands** in the ⌘K palette, **colour themes**, and even **new agents**.

## Using plugins

Open **Settings → Plugins** (or **Manage** next to the Plugins heading in the sidebar).

- Each plugin lists exactly what it's allowed to do, such as "Read your chats". Plugins stay **off** until you turn them on.
- **Create example plugin** adds *Hello Noai*, which shows every kind of plugin.
- **Delete** removes a plugin's folder (tap twice).

Plugins live in `~/.noai/plugins`. Themes from plugins (like **World flags**) appear in **Settings → Appearance**, where you can search them by name.

## Writing your own

A plugin is a folder with a `plugin.json`. Plugin pages run in a sandbox and can only reach Noai through a small API, and only for the permissions they ask for. The full guide is `PLUGINS.md` in the Noai repository.
