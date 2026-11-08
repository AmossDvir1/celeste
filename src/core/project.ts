import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ProjectApi } from '@shared/api'

/** The branch a folder is on, or null when it is not a git folder (or git is not installed). */
function currentBranch(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'branch', '--show-current'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const branch = err ? '' : stdout.trim()
      resolve(branch || null)
    })
  })
}

/** What Develop shows about the folder you chose. Read only: it never changes the folder. */
export const projectApi: ProjectApi = {
  'project.inspect': async (path) => {
    if (typeof path !== 'string' || path.length > 1000 || !isAbsolute(path)) throw new Error('Invalid folder')
    let folder = false
    try {
      folder = statSync(path).isDirectory()
    } catch {
      folder = false
    }
    return { exists: folder, branch: folder ? await currentBranch(path) : null }
  }
}
