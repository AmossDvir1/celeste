import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** What Windows is told to add to Celeste's command when it starts at sign-in, so the window stays in the tray. */
export const BACKGROUND_ARG = '--background'

/**
 * Starting Celeste when the person signs in (docs/plans/SCHEDULING_PLAN.md, 4.6): a schedule only runs while Celeste does. The operating
 * system is the store (Settings, Apps, Startup shows it too), so there is no setting of ours to go out of step with it.
 *
 * Only an installed Celeste on Windows: a run from the project would register the development copy of Electron, and the Mac and Linux
 * ways of doing this are not worked out. `CELESTE_FAKE_LOGIN_ITEM` names a file that stands in for the system, for the app checks.
 */
export class LoginItem {
  constructor(private readonly fake: string | undefined = process.env['CELESTE_FAKE_LOGIN_ITEM']) {}

  get available(): boolean {
    return !!this.fake || (process.platform === 'win32' && app.isPackaged)
  }

  get enabled(): boolean {
    if (!this.available) return false
    if (this.fake) return existsSync(this.fake) && readFileSync(this.fake, 'utf8') === 'on'
    return app.getLoginItemSettings({ args: [BACKGROUND_ARG] }).openAtLogin
  }

  set(on: boolean): void {
    if (!this.available) throw new Error('Starting Celeste with the computer is only possible from the installed Celeste on Windows.')
    if (this.fake) writeFileSync(this.fake, on ? 'on' : 'off')
    else app.setLoginItemSettings({ openAtLogin: on, args: [BACKGROUND_ARG] })
  }

  state(): { available: boolean; enabled: boolean } {
    return { available: this.available, enabled: this.enabled }
  }
}
