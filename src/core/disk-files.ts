import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FileStore } from './store'

/** Attachment bytes in a folder. The window shows them through the `celeste-file://attachments/` address. */
export class DiskFileStore implements FileStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  save(id: string, ext: string, _mime: string, data: ArrayBuffer): { file: string; url: string } {
    const file = `${id}.${ext}`
    const target = join(this.dir, file)
    // Written under another name first, so a crash never leaves half a file under the real one.
    const partial = `${target}.partial`
    writeFileSync(partial, Buffer.from(data))
    renameSync(partial, target)
    return { file, url: `celeste-file://attachments/${file}` }
  }

  remove(file: string): void {
    if (!/^[\w-]+\.[a-z0-9]{1,5}$/.test(file)) return
    rmSync(join(this.dir, file), { force: true })
  }
}
