// Shared helpers for the screenshot and comparison scripts: start the built app and capture it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

export const root = resolve(import.meta.dirname, '..', '..')

/**
 * Launches the built app (run `electron-vite build` first), sized so the page content is exactly width x height.
 * `query` picks a view, for example "bare=chat". Returns { app, page, close }.
 * It runs with a throwaway profile folder, so it neither clashes with a running `npm run dev` window
 * (one instance per profile) nor writes settings into your real profile. Pass `profile` (a folder) to
 * reuse one across launches, for example to test that data survives a restart; it is then left in place.
 * `entry` runs something other than the project folder, for example a packed app.asar.
 */
export async function launch({ width, height, query = '', theme = 'dark', profile: given, entry = root }) {
  const profile = given ?? mkdtempSync(join(tmpdir(), 'celeste-shots-'))
  const app = await electron.launch({
    args: [entry, `--user-data-dir=${profile}`],
    env: { ...process.env, CELESTE_QUERY: query, ELECTRON_RENDERER_URL: '' }
  })
  const page = await app.firstWindow()
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setMinimumSize(200, 200)
      win.setContentSize(w, h)
    },
    [width, height]
  )
  await page.waitForLoadState('domcontentloaded')
  // `theme: null` leaves the theme the app chose for itself.
  if (theme) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t
    }, theme)
  }
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(700)
  const size = await page.evaluate(() => [window.innerWidth, window.innerHeight])
  if (size[0] !== width || size[1] !== height) {
    console.warn(`window content is ${size[0]}x${size[1]}, wanted ${width}x${height}`)
  }
  return {
    app,
    page,
    profile,
    /** Quits the app the normal way. */
    close: async () => {
      await app.close()
      if (!given) rmSync(profile, { recursive: true, force: true })
    },
    /**
     * Ends the main process on the spot, with no chance to save, as a crash or power cut would.
     * (Killing the handle Playwright holds does not stop Electron on Windows, so it kills itself.)
     */
    crash: async () => {
      const proc = app.process()
      const gone = new Promise((resolve) => proc.once('exit', resolve))
      await app.evaluate(() => process.kill(process.pid, 'SIGKILL')).catch(() => undefined)
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 8000))])
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
}

/** Saves settings through the app's own API, the way the interface does. */
export async function saveSettings(page, patch) {
  await page.evaluate((p) => window.celeste.core.call('settings.patch', [p]), patch)
}
