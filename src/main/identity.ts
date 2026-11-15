import { execFile } from 'node:child_process'

/**
 * Who Celeste is to Windows: the id that notifications and taskbar buttons are filed under. The installer gives its shortcuts this same
 * id (it is the `appId` of electron-builder.yml), which is where Windows finds the name and the icon to show. Keep the two the same.
 */
export const APP_ID = 'io.github.amossdvir1.celeste'

/** The registry commands that give an id a name and a picture, for a program that has no installed shortcut. */
export function identityCommands(id: string, name: string, icon: string): string[][] {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${id}`
  return [
    ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', name, '/f'],
    ['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', icon, '/f']
  ]
}

/**
 * A development run is Electron's own program, started from the project, with no installer and so no shortcut: Windows would show
 * "Electron" and its atom on every notification and on the taskbar button. This files a name and a picture for Celeste's id under
 * the person's own account (HKCU, nothing system wide), where Windows looks for them. It is only done for a run that is not installed.
 */
export function registerDevIdentity(name: string, icon: string): void {
  if (process.platform !== 'win32') return
  for (const args of identityCommands(APP_ID, name, icon)) {
    execFile('reg', args, { windowsHide: true }, () => {
      /* the notification then shows the program's own name, which is only a look */
    })
  }
}
