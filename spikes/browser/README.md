# Browser spike (throwaway)

The step 0 spike of `docs/BROWSER_PLAN.md`, kept as the starting point for step 1 and 2. Not part of the app and not built.

- `main.js`, `preload.js`, `index.html`: a tiny Electron window with a placeholder and a `WebContentsView` that follows it.
- `bridge.js`: the filtering DevTools endpoint that Playwright connects to. It uses the `ws` server bundled inside `playwright-core`; the real version uses the `ws` package.
- `t3-bridge.mjs`: connects with `connectOverCDP` and checks pages, click, fill, screenshot, console, a cross-site iframe, element refs, new tab, `target=_blank` and close.

Run it: `node spikes/browser/t3-bridge.mjs` (opens a window for a few seconds).
