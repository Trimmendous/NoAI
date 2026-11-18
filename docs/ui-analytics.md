# Local activity dashboard

Home is the initial view. Its filters apply to usage, model/harness leaders, cache rate, tool counts, comparisons, and Noai occurrence statistics. Most-used is measured by recorded input plus output tokens. A provider session is counted once where its identity is known; otherwise a Noai run is counted separately. Occurrences are selected by start time and counted once across timed resumes. Imported histories do not imply successful job outcomes.

The last 24 hours is a rolling 24-hour window. Seven- and 31-day windows subtract local calendar days at the same clock time, including daylight-saving changes. Preceding periods are adjacent and do not overlap. Hourly buckets distinguish repeated daylight-saving hours; longer charts use local calendar buckets with partial first/last buckets. All-time charts bound the number of buckets. Zero comparison baselines have no percentage change.

Input includes cache reads. Stacks split input into cached reads and input without cache reads, then add output. The latter category includes cache writes when the existing importer has not retained them separately. Cache-hit rate is cached reads divided by all input. Existing import deduplication and cumulative-counter normalization remain in place. Job detail additionally restricts imported usage to the occurrence's time bounds.

Cost is optional: only explicitly recorded, per-event USD amounts are additive. Missing, cumulative, estimated, or other-currency amounts are unavailable. Coverage counts usage reports with supported recorded costs; chart gaps are not zero-dollar observations. Current local imports do not supply those costs, so the interface shows unavailable. No model price estimates or subscription charges are inferred.

Charts use cached metric records, not transcript rescans, when changing filters or display style. SVG marks have exact hover/focus labels and table equivalents. Transcript tools and readable recorded thinking remain collapsed; encrypted or redacted reasoning is omitted. Read/parse errors are surfaced without logging transcript contents. Additional daemon importer diagnostics become active when that daemon eventually runs the rebuilt binary; the UI work does not restart it.

## Verification

- `npm run check` and `npm test`
- `cargo test --manifest-path src-tauri/Cargo.toml --release`
- `npm run desktop:build`
- `test/ui.browser.mjs` runs synthetic-only browser checks against a preview at port 1437. Provide Playwright through `NOAI_PLAYWRIGHT` (an absolute module path), or install it in your test environment. `NOAI_PREVIEW_URL` and `NOAI_SCREENSHOTS` override the preview URL and local screenshot folder. Tests cover initial Home, chart controls without refetches, missing/partial cost, load failures, session pagination/scroll restoration, run selection, sticky Back after long transcripts, and light/dark narrow layouts.

Read-only real-data integration was checked against 187 history files and 19,474 normalized records. Aggregation took approximately 57 ms in that check; token stack sums matched reported totals. Private transcripts were not used in browser fixtures or screenshots.
