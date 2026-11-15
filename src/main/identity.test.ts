import { describe, expect, it } from 'vitest'
import { APP_ID, identityCommands } from './identity'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('identity', () => {
  it('is the appId the installer gives its shortcuts, so Windows finds the name and icon there', () => {
    const yml = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(yml).toMatch(new RegExp(`^appId: ${APP_ID.replace(/\./g, '\\.')}$`, 'm'))
  })

  it('files a name and a picture under the person’s own account, and nowhere else', () => {
    const commands = identityCommands(APP_ID, 'Celeste', 'C:\\app\\icon.png')
    expect(commands).toHaveLength(2)
    for (const c of commands) {
      expect(c[0]).toBe('add')
      expect(c[1]).toBe(`HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`)
    }
    expect(commands.map((c) => c[3])).toEqual(['DisplayName', 'IconUri'])
    expect(commands[0]?.[7]).toBe('Celeste')
    expect(commands[1]?.[7]).toBe('C:\\app\\icon.png')
  })
})
