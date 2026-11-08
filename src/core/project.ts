import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ProjectApi } from '@shared/api'
import type { Worktrees } from './worktrees'

/** The branch a folder is on, or null when it is not a git folder (or git is not installed). */
function currentBranch(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'branch', '--show-current'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const branch = err ? '' : stdout.trim()
      resolve(branch || null)
    })
  })
}

/**
 * What Develop shows about the folder you chose (read only: looking never changes it), and the separate copies of a project
 * that Celeste makes. `sessionAt` says which session works in a copy.
 */
export const createProjectApi = (worktrees: Worktrees, sessionAt: (path: string) => { id: string; title: string } | undefined, beforeRemoving: (path: string) => void): ProjectApi => ({
  'project.createWorktree': (repo, hint) => worktrees.create(repo, hint),
  'project.worktrees': async () => (await worktrees.list()).map((w) => ({ ...w, ...(sessionAt(w.path) ? { session: sessionAt(w.path) } : {}) })),
  'project.removeWorktree': (path) => {
    // An agent working in the folder holds it open, and Windows will not delete a folder that is in use.
    if (worktrees.isCopy(path)) beforeRemoving(path)
    return worktrees.remove(path)
  },
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
})
