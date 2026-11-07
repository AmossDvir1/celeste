// Shared helpers for the screenshot and comparison scripts: start the built app and capture it.
import { resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

export const root = resolve(import.meta.dirname, '..', '..')

/**
 * Launches the built app (run `electron-vite build` first), sized so the page content is exactly width x height.
 * `query` picks a view, for example "bare=chat". Returns { app, page, close }.
 */
export async function launch({ width, height, query = '', theme = 'dark' }) {
  const app = await electron.launch({
    args: [root],
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
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t
  }, theme)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(700)
  const size = await page.evaluate(() => [window.innerWidth, window.innerHeight])
  if (size[0] !== width || size[1] !== height) {
    console.warn(`window content is ${size[0]}x${size[1]}, wanted ${width}x${height}`)
  }
  return { app, page, close: () => app.close() }
}
