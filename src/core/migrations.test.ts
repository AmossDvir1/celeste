import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'celeste-migrate-'))
  vi.resetModules()
})
afterEach(() => {
  vi.doUnmock('./migrations')
  rmSync(dir, { recursive: true, force: true })
})

const version = (path: string) => {
  const db = new DatabaseSync(path)
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  db.close()
  return v
}

describe('database migrations', () => {
  it('creates the schema on a new database and leaves an existing one alone', async () => {
    const { SqliteStore } = await import('./sqlite-store')
    const { MIGRATIONS } = await import('./migrations')
    const path = join(dir, 'a.db')

    const first = new SqliteStore(path)
    first.setSetting('kept', 1)
    first.close()
    expect(version(path)).toBe(MIGRATIONS.length)

    const again = new SqliteStore(path)
    expect(again.settings()).toEqual({ kept: 1 })
    again.close()
    expect(existsSync(`${path}.v${MIGRATIONS.length}.bak`)).toBe(false)
  })

  it('upgrades an older database, keeps its data and saves a copy of the old file first', async () => {
    const real = (await vi.importActual<typeof import('./migrations')>('./migrations')).MIGRATIONS
    const path = join(dir, 'b.db')

    vi.doMock('./migrations', () => ({ MIGRATIONS: real }))
    const old = new (await import('./sqlite-store')).SqliteStore(path)
    old.setSetting('theme', 'light')
    old.close()
    expect(version(path)).toBe(real.length)

    vi.resetModules()
    vi.doMock('./migrations', () => ({ MIGRATIONS: [...real, 'ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;'] }))
    const upgraded = new (await import('./sqlite-store')).SqliteStore(path)
    expect(upgraded.settings()).toEqual({ theme: 'light' })
    upgraded.close()

    expect(version(path)).toBe(real.length + 1)
    expect(existsSync(`${path}.v${real.length}.bak`)).toBe(true)
    expect(version(`${path}.v${real.length}.bak`)).toBe(real.length)
  })

  it('refuses a database from a newer Celeste without touching it', async () => {
    const path = join(dir, 'c.db')
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 99; CREATE TABLE future (x)')
    raw.close()

    const { SqliteStore } = await import('./sqlite-store')
    expect(() => new SqliteStore(path)).toThrow(/newer version of Celeste/)
    expect(version(path)).toBe(99)
  })

  it('rolls a failed migration back completely', async () => {
    const real = (await vi.importActual<typeof import('./migrations')>('./migrations')).MIGRATIONS
    const path = join(dir, 'd.db')
    vi.doMock('./migrations', () => ({ MIGRATIONS: [...real, 'CREATE TABLE half (x); THIS IS NOT SQL;'] }))
    const { SqliteStore } = await import('./sqlite-store')
    expect(() => new SqliteStore(path)).toThrow()

    // The first step succeeded and stays; the broken one left no trace.
    expect(version(path)).toBe(real.length)
    const db = new DatabaseSync(path)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined()
    db.close()
  })
})
