import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * API keys and tokens, encrypted with the operating system's own store (Windows DPAPI, the macOS keychain,
 * the Linux secret service). They live in this process only: the window can store and remove a secret and
 * learn its last four characters, but never read it back. If the system cannot encrypt, nothing is stored.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const path = () => join(app.getPath('userData'), 'secrets.json')

function load(): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(path(), 'utf8')) as Record<string, string>
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function save(data: Record<string, string>): void {
  mkdirSync(dirname(path()), { recursive: true })
  const partial = `${path()}.partial`
  writeFileSync(partial, JSON.stringify(data), { mode: 0o600 })
  renameSync(partial, path())
}

function assertName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('Invalid secret name')
}

export const secrets = {
  available: (): boolean => safeStorage.isEncryptionAvailable(),

  set(name: unknown, value: unknown): void {
    assertName(name)
    if (typeof value !== 'string' || value.length === 0 || value.length > 32768) throw new Error('Invalid secret')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer cannot store secrets securely.')
    save({ ...load(), [name]: safeStorage.encryptString(value).toString('base64') })
  },

  /** For the main process only, which hands secrets to Core in memory when a vendor needs one. */
  get(name: string): string | null {
    const stored = load()[name]
    if (!stored) return null
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  },

  remove(name: unknown): void {
    assertName(name)
    const { [name]: _gone, ...rest } = load()
    save(rest)
  },

  has: (name: unknown): boolean => {
    assertName(name)
    return secrets.get(name) !== null
  },

  /** The last four characters, enough to tell two keys apart on a card. */
  hint: (name: unknown): string | null => {
    assertName(name)
    return secrets.get(name)?.slice(-4) ?? null
  }
}
