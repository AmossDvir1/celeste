import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Worktrees, slug } from './worktrees'

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let outer: string
let repo: string
let worktrees: Worktrees
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
const commit = (cwd: string, message: string) => {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', message)
}

beforeEach(() => {
  outer = mkdtempSync(join(tmpdir(), 'celeste-wt-'))
  repo = join(outer, 'shop-web')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'committed\n')
  commit(repo, 'first')
  worktrees = new Worktrees(join(outer, 'data', 'worktrees'))
})
afterEach(() => rmSync(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

describe('words in a branch name', () => {
  it('keeps letters and numbers, drops the rest, and is never empty or long', () => {
    expect(slug('Fix the flaky checkout test!')).toBe('fix-the-flaky-checkout-test')
    expect(slug('../../etc; rm -rf /')).toBe('etc-rm-rf')
    expect(slug('')).toBe('session')
    expect(slug('???')).toBe('session')
    expect(slug('Ünïcode and émojis 🎉')).toBe('unicode-and-emojis')
    expect(slug('x'.repeat(100)).length).toBeLessThanOrEqual(30)
  })
})

describe.skipIf(!hasGit)('separate copies of a project', () => {
  it('makes a copy of the last commit on a new branch, in its own folder, without touching the project', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed but not committed\n')
    writeFileSync(join(repo, 'new.txt'), 'untracked\n')
    const made = await worktrees.create(repo, 'Fix the flaky test')

    expect(worktrees.isCopy(made.path)).toBe(true)
    expect(made.path.startsWith(worktrees.dir)).toBe(true)
    expect(basename(made.path)).toMatch(/^shop-web-[0-9a-f]{8}$/)
    expect(made.branch).toMatch(/^celeste\/fix-the-flaky-test-[0-9a-f]{8}$/)
    // The copy has what was committed, not what was changed afterwards (line endings are whatever the person's git is set to).
    expect(readFileSync(join(made.path, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('committed\n')
    expect(existsSync(join(made.path, 'new.txt'))).toBe(false)
    expect(git(made.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(made.branch)
    // The project itself is as it was, apart from knowing about the branch.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('changed but not committed\n')
    expect(git(repo, 'branch', '--list', made.branch)).toContain(made.branch)
  })

  it('makes a different copy each time, even for the same words', async () => {
    const one = await worktrees.create(repo, 'same words')
    const two = await worktrees.create(repo, 'same words')
    expect(one.path).not.toBe(two.path)
    expect(one.branch).not.toBe(two.branch)
  })

  it('works from a folder inside the project, and says plainly when it cannot', async () => {
    mkdirSync(join(repo, 'src'))
    const inner = await worktrees.create(join(repo, 'src'), 'from inside')
    expect(existsSync(join(inner.path, 'a.txt'))).toBe(true)

    const plain = join(outer, 'plain')
    mkdirSync(plain)
    await expect(worktrees.create(plain, 'x')).rejects.toThrow(/needs a git project/)
    await expect(worktrees.create(join(outer, 'nope'), 'x')).rejects.toThrow(/needs a git project/)

    const empty = join(outer, 'empty')
    mkdirSync(empty)
    git(empty, 'init', '-q', '-b', 'main')
    await expect(worktrees.create(empty, 'x')).rejects.toThrow(/no commits yet/)
  })

  it('lists copies with what has changed in them and the commits only they have', async () => {
    const made = await worktrees.create(repo, 'list me')
    expect(await worktrees.list()).toEqual([{ path: made.path, name: basename(made.path), branch: made.branch, repo: expect.stringContaining('shop-web'), changed: 0, ahead: 0 }])

    writeFileSync(join(made.path, 'a.txt'), 'edited\n')
    writeFileSync(join(made.path, 'b.txt'), 'new\n')
    expect((await worktrees.list())[0]).toMatchObject({ changed: 2, ahead: 0 })

    commit(made.path, 'work in the copy')
    writeFileSync(join(made.path, 'c.txt'), 'later\n')
    expect((await worktrees.list())[0]).toMatchObject({ changed: 1, ahead: 1 })

    // Merged into the project's branch, the commit is no longer only here.
    git(repo, 'merge', '-q', '--ff-only', made.branch)
    expect((await worktrees.list())[0]).toMatchObject({ ahead: 0 })
  })

  it('lists nothing before any copy has been made, and ignores folders that are not copies', async () => {
    expect(await worktrees.list()).toEqual([])
    mkdirSync(join(worktrees.dir, 'stray folder'), { recursive: true })
    writeFileSync(join(worktrees.dir, 'stray file'), 'x')
    expect(await worktrees.list()).toEqual([])
  })

  it('removes a copy and its branch, and leaves the project and its other branches alone', async () => {
    const keep = await worktrees.create(repo, 'keep')
    const gone = await worktrees.create(repo, 'remove')
    writeFileSync(join(gone.path, 'unsaved.txt'), 'this is lost on purpose')
    await worktrees.remove(gone.path)
    expect(existsSync(gone.path)).toBe(false)
    expect(git(repo, 'branch', '--list', gone.branch)).toBe('')
    expect(git(repo, 'worktree', 'list')).not.toContain(basename(gone.path))
    expect(existsSync(keep.path)).toBe(true)
    expect(git(repo, 'branch', '--list', keep.branch)).toContain(keep.branch)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('committed\n')
    // Removing what is already gone is not an error.
    await worktrees.remove(gone.path)
  })

  it('still clears a copy whose project has been moved away', async () => {
    const made = await worktrees.create(repo, 'orphan')
    rmSync(repo, { recursive: true, force: true })
    await worktrees.remove(made.path)
    expect(existsSync(made.path)).toBe(false)
  })

  it('refuses to remove anything that is not a copy it made', async () => {
    const outside = join(outer, 'precious')
    mkdirSync(outside)
    writeFileSync(join(outside, 'file.txt'), 'keep me')
    await expect(worktrees.remove(outside)).rejects.toThrow(/not a separate copy/)
    await expect(worktrees.remove(repo)).rejects.toThrow(/not a separate copy/)
    await expect(worktrees.remove(worktrees.dir)).rejects.toThrow(/not a separate copy/)
    await expect(worktrees.remove(join(worktrees.dir, '..', 'precious'))).rejects.toThrow(/not a separate copy/)
    await expect(worktrees.remove(42 as unknown as string)).rejects.toThrow(/not a separate copy/)
    mkdirSync(join(worktrees.dir, 'plain-folder'), { recursive: true })
    await expect(worktrees.remove(join(worktrees.dir, 'plain-folder'))).rejects.toThrow(/not a working copy/)
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(join(worktrees.dir, 'plain-folder'))).toBe(true)
  })

  it('knows which folders are its copies', () => {
    expect(worktrees.isCopy(join(worktrees.dir, 'x-1234'))).toBe(true)
    expect(worktrees.isCopy(worktrees.dir)).toBe(false)
    expect(worktrees.isCopy(repo)).toBe(false)
    expect(worktrees.isCopy(join(worktrees.dir, '..', 'worktrees-evil', 'x'))).toBe(false)
    expect(worktrees.isCopy(undefined)).toBe(false)
  })
})
