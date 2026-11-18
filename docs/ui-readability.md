# Conversation access and shared surfaces

The existing dedicated job/conversation pages are retained. Completed cards previously had no explicit action, and detail conversation access was disabled when no run record existed. Cards now expose Open job and details always expose Open conversation, with an explanation when no saved history exists. Explicit historical selection is pinned to its run ID; refresh cannot substitute the newest run. A missing historical prompt is identified rather than presenting the current job prompt as a saved message. Conversation entry resets its scroll position and Back restores focus to its opener.

The new shared surface stylesheet groups toolbars, insights, job queues, statistics and transcripts, keeping the recurring/one-time/completed arrangement. Theme tokens improve secondary text and light-theme accent contrast. Existing sticky navigation, reduced motion, filters, pagination, copy controls, collapsible activity, Retry and permissions remain in place. No persistence or scheduler changes were made.

## Verification

`npm run check`, `npm test`, and `npm run desktop:build` verify syntax, existing unit coverage and the desktop binary. The browser regression uses synthetic IPC fixtures only; it never connects to the daemon. Install Playwright in a separate test environment, then run:

```sh
NOAI_PORT=1448 npm run dev
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run test:browser
```

`NOAI_PREVIEW` overrides the preview URL. `NOAI_SCREENSHOTS` overrides the default screenshot directory `/tmp/noai-readability`. Coverage includes completed one-time jobs, recurring historical selection, direct occurrence navigation, absent/disappearing history, recorded thinking/tool collapsibles, copy controls, original-prompt state, keyboard entry, Back focus/sticky placement, page errors and narrow overflow. Screenshots cover Home, charts, Jobs, job/session details and conversations at 1280px and 390px in both themes with reduced motion.

The desktop build emits the existing STATIC_VCRUNTIME deprecation warning. Reopen the GUI using the rebuilt binary to load its bundled frontend; no daemon restart is required for these frontend-only changes.
