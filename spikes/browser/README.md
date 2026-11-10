# Browser spike (kept for the record)

The step 0 spike of `docs/BROWSER_PLAN.md`. It is not part of the app and is not built. The real bridge is `src/main/browser/bridge.ts` and the
real pane is `src/main/browser/service.ts`; what the spike found, and what the bridge needed beyond it, is in the plan (section 8, steps 0 and 2).

- `main.js`, `preload.js`, `index.html`: a tiny Electron window with a placeholder and a `WebContentsView` that follows it.
- `bridge.js`: the first version of the DevTools endpoint Playwright connects to (it takes its WebSocket server from inside `playwright-core`; the real one uses the `ws` package).
- `t3-bridge.mjs`: connects with `connectOverCDP` and checks pages, click, fill, screenshot, console, a cross-site iframe, element refs, a new tab, `target=_blank` and close.
- `t6-mapping.mjs`: tries `newCDPSession`, which is how Core finds which page is which tab. It crashes this spike's bridge with "Duplicate target": that is what the real bridge's browser-level session is for.

Run the first one with `node spikes/browser/t3-bridge.mjs` (a window opens for a few seconds).
