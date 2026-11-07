import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FileOps } from './device-service'

/** File operations on this computer's disk, for the app and for tests. */
export const nodeFileOps: FileOps = {
  join,
  dirname,
  mkdirp: async (path) => void (await mkdir(path, { recursive: true })),
  remove: (path) => rm(path, { recursive: true, force: true })
}
