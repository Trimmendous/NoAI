# Agent logos

Drop a small logo here and Noai uses it instead of the coloured letter tile for
that agent, everywhere: sidebar lists, Sessions, Accounts, Models and Activity.

- Name the file after the agent's ID: `claude.svg`, `codex.svg`, `gemini.svg`,
  `copilot.svg`, `cursor.svg`, `openrouter.svg`. Any new agent works the same way.
- SVG is best. PNG works too (`claude.png`); make it square, at least 64×64.
- Logos sit on a tile tinted with the agent's colour that follows your theme, so use a
  transparent background (no white box baked in).
- A one-colour black SVG is detected automatically and shown in white on dark themes.
  Coloured logos are shown as drawn.
- No logo file? The agent keeps its coloured letter tile.

These are other companies' trademarks, so use the official assets from each
company's brand or press page and follow their guidelines.

## Where these came from

- `claude`, `gemini`, `copilot`, `cursor`, `openrouter`: [Simple Icons](https://simpleicons.org) 16.38.0,
  filled with each brand's listed colour (OpenRouter uses its dark mark for contrast).
- `codex`: [LobeHub Icons](https://github.com/lobehub/lobe-icons) 1.104.0 (`codex-color`), with its
  white backing square removed so it sits on the themed tile like the others.

The marks themselves belong to Anthropic, Google, GitHub, Anysphere, OpenRouter and OpenAI.
They're used only to identify each tool; Noai isn't affiliated with or endorsed by them.
