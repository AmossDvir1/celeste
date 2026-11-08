import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitSnapshots, SnapshotError } from './snapshots'

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let project: string
let data: string
let snaps: GitSnapshots

const put = (rel: string, content: string | Buffer) => {
  const full = join(project, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}
const text = (rel: string) => readFileSync(join(project, rel), 'utf8')
const has = (rel: string) => existsSync(join(project, rel))
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'celeste-project-'))
  data = mkdtempSync(join(tmpdir(), 'celeste-snapdata-'))
  snaps = new GitSnapshots(join(data, 'snapshots'))
})
afterEach(() => {
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe.skipIf(!hasGit)('checkpoints of a project folder', () => {
  it('saves the folder and says what changed between two saves', async () => {
    put('a.txt', 'one\ntwo\n')
    put('gone.txt', 'bye\n')
    put('src/keep.ts', 'same\n')
    const before = await snaps.take('s1', project)
    expect(before).toMatch(/^[0-9a-f]{40}$/)

    put('a.txt', 'one\nTWO\nthree\n')
    put('new/dir/file.txt', 'fresh\n')
    rmSync(join(project, 'gone.txt'))
    const after = await snaps.take('s1', project)

    const { files, more } = await snaps.changes('s1', project, before, after)
    expect(more).toBe(0)
    expect(files).toEqual([
      { path: 'a.txt', status: 'modified', added: 2, removed: 1 },
      { path: 'gone.txt', status: 'deleted', added: 0, removed: 1 },
      { path: 'new/dir/file.txt', status: 'added', added: 1, removed: 0 }
    ])
  })

  it('reports no changes when nothing changed', async () => {
    put('a.txt', 'x')
    const one = await snaps.take('s1', project)
    const two = await snaps.take('s1', project)
    expect(one).not.toBe(two)
    expect(await snaps.changes('s1', project, one, two)).toEqual({ files: [], more: 0 })
  })

  it('puts back edited and deleted files, removes new ones and the folders they leave empty, and leaves the rest alone', async () => {
    put('a.txt', 'original\n')
    put('gone.txt', 'still here\n')
    put('src/keep.ts', 'untouched\n')
    const checkpoint = await snaps.take('s1', project)

    put('a.txt', 'edited by the agent\n')
    rmSync(join(project, 'gone.txt'))
    put('made/deep/new.txt', 'created by the agent\n')
    put('made/other.txt', 'also created\n')

    const result = await snaps.restore('s1', project, checkpoint)
    expect(result).toMatchObject({ restored: 2, removed: 2 })
    expect(result.undoId).toMatch(/^[0-9a-f]{40}$/)
    expect(text('a.txt')).toBe('original\n')
    expect(text('gone.txt')).toBe('still here\n')
    expect(text('src/keep.ts')).toBe('untouched\n')
    expect(has('made/deep/new.txt')).toBe(false)
    expect(has('made')).toBe(false)
  })

  it('can undo a revert, and undo the undo', async () => {
    put('a.txt', 'v1\n')
    const start = await snaps.take('s1', project)
    put('a.txt', 'v2\n')
    put('extra.txt', 'extra\n')

    const first = await snaps.restore('s1', project, start)
    expect(text('a.txt')).toBe('v1\n')
    expect(has('extra.txt')).toBe(false)

    const second = await snaps.restore('s1', project, first.undoId)
    expect(text('a.txt')).toBe('v2\n')
    expect(text('extra.txt')).toBe('extra\n')

    await snaps.restore('s1', project, second.undoId)
    expect(text('a.txt')).toBe('v1\n')
    expect(has('extra.txt')).toBe(false)
  })

  it('keeps files exactly as they are, including line endings and unusual names', async () => {
    const crlf = Buffer.from('line one\r\nline two\r\n')
    const binary = Buffer.from([0, 1, 2, 255, 254, 0, 13, 10])
    put('crlf.txt', crlf)
    put('blob.bin', binary)
    put('my file ünï.txt', 'unicode name\n')
    put('dir with space/a b.txt', 'spaces\n')
    put('[x] file.txt', 'glob characters\n')
    const checkpoint = await snaps.take('s1', project)

    put('crlf.txt', 'changed')
    put('blob.bin', 'changed')
    rmSync(join(project, 'my file ünï.txt'))
    rmSync(join(project, 'dir with space'), { recursive: true })
    rmSync(join(project, '[x] file.txt'))

    await snaps.restore('s1', project, checkpoint)
    expect(readFileSync(join(project, 'crlf.txt')).equals(crlf)).toBe(true)
    expect(readFileSync(join(project, 'blob.bin')).equals(binary)).toBe(true)
    expect(text('my file ünï.txt')).toBe('unicode name\n')
    expect(text('dir with space/a b.txt')).toBe('spaces\n')
    expect(text('[x] file.txt')).toBe('glob characters\n')
    // A name with pattern characters in it was restored as a name: as a pattern, [x] would only match "x".
  })

  it('never touches the project’s own git history', async () => {
    git(project, 'init', '-q')
    git(project, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first')
    put('a.txt', 'one\n')
    git(project, 'add', '.')
    git(project, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add a')
    const refs = git(project, 'for-each-ref')
    const head = git(project, 'rev-parse', 'HEAD')
    const gitFolder = readdirSync(join(project, '.git')).sort()

    const checkpoint = await snaps.take('s1', project)
    put('a.txt', 'two\n')
    put('b.txt', 'new\n')
    await snaps.restore('s1', project, checkpoint)

    expect(text('a.txt')).toBe('one\n')
    expect(has('b.txt')).toBe(false)
    expect(git(project, 'for-each-ref')).toBe(refs)
    expect(git(project, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(project, 'stash', 'list')).toBe('')
    expect(git(project, 'status', '--porcelain')).toBe('')
    expect(readdirSync(join(project, '.git')).sort()).toEqual(gitFolder)
  })

  it('works in a folder that is not a git project at all', async () => {
    put('a.txt', 'one\n')
    const checkpoint = await snaps.take('s1', project)
    put('a.txt', 'two\n')
    await snaps.restore('s1', project, checkpoint)
    expect(text('a.txt')).toBe('one\n')
    expect(has('.git')).toBe(false)
  })

  it('leaves out what .gitignore ignores, and node_modules whatever the project says', async () => {
    put('.gitignore', 'secret.env\nbuild/\n')
    put('secret.env', 'KEY=1\n')
    put('build/out.js', 'built\n')
    put('node_modules/pkg/index.js', 'dep\n')
    put('a.txt', 'one\n')
    const checkpoint = await snaps.take('s1', project)

    put('secret.env', 'KEY=changed\n')
    put('build/out.js', 'rebuilt\n')
    put('node_modules/pkg/index.js', 'changed dep\n')
    put('node_modules/new/index.js', 'new dep\n')
    put('a.txt', 'two\n')
    const after = await snaps.take('s1', project)
    expect((await snaps.changes('s1', project, checkpoint, after)).files.map((f) => f.path)).toEqual(['a.txt'])

    await snaps.restore('s1', project, checkpoint)
    expect(text('a.txt')).toBe('one\n')
    // What is ignored is not the checkpoint's business, in either direction.
    expect(text('secret.env')).toBe('KEY=changed\n')
    expect(text('build/out.js')).toBe('rebuilt\n')
    expect(text('node_modules/pkg/index.js')).toBe('changed dep\n')
    expect(has('node_modules/new/index.js')).toBe(true)
  })

  it('leaves out a file that is too big, and remembers it', async () => {
    const small = new GitSnapshots(join(data, 'small'), { file: 100 })
    put('a.txt', 'one\n')
    put('video.bin', Buffer.alloc(500, 7))
    const checkpoint = await small.take('s1', project)
    put('video.bin', Buffer.alloc(500, 9))
    put('a.txt', 'two\n')
    const after = await small.take('s1', project)
    expect((await small.changes('s1', project, checkpoint, after)).files.map((f) => f.path)).toEqual(['a.txt'])
    await small.restore('s1', project, checkpoint)
    expect(readFileSync(join(project, 'video.bin'))[0]).toBe(9)
    expect(text('a.txt')).toBe('one\n')
  })

  it('refuses a folder that is too large, in words, and a folder that does not exist or is far too broad', async () => {
    const tight = new GitSnapshots(join(data, 'tight'), { files: 3 })
    for (const n of [1, 2, 3, 4]) put(`f${n}.txt`, 'x')
    await expect(tight.take('s1', project)).rejects.toThrow(/too large to checkpoint \(4 files/)
    await expect(snaps.take('s2', join(project, 'nope'))).rejects.toThrow(/not there any more/)
    await expect(snaps.take('s3', parse(project).root)).rejects.toThrow(/too broad/)
    await expect(snaps.take('s3', parse(project).root)).rejects.toBeInstanceOf(SnapshotError)
  })

  it('shows what a revert would change, as it would be afterwards, without changing anything', async () => {
    put('a.txt', 'one\n')
    put('gone.txt', 'bye\n')
    const checkpoint = await snaps.take('s1', project)
    put('a.txt', 'one\ntwo\nthree\n')
    rmSync(join(project, 'gone.txt'))
    put('made.txt', 'new\n')

    const preview = await snaps.preview('s1', project, checkpoint)
    expect(preview.files).toEqual([
      { path: 'a.txt', status: 'modified', added: 0, removed: 2 },
      { path: 'gone.txt', status: 'added', added: 1, removed: 0 },
      { path: 'made.txt', status: 'deleted', added: 0, removed: 1 }
    ])
    expect(text('a.txt')).toBe('one\ntwo\nthree\n')
    expect(has('made.txt')).toBe(true)
  })

  it('lists at most 200 files and says how many more', async () => {
    const before = await snaps.take('s1', project)
    for (let i = 0; i < 230; i++) put(`many/f${String(i).padStart(3, '0')}.txt`, 'x')
    const after = await snaps.take('s1', project)
    const { files, more } = await snaps.changes('s1', project, before, after)
    expect(files).toHaveLength(200)
    expect(more).toBe(30)
  })

  it('refuses a checkpoint it does not know, or one that is not an id at all', async () => {
    put('a.txt', 'x')
    await snaps.take('s1', project)
    await expect(snaps.restore('s1', project, 'not-an-id')).rejects.toThrow(/Invalid checkpoint/)
    await expect(snaps.restore('s1', project, '../../etc')).rejects.toThrow(/Invalid checkpoint/)
    await expect(snaps.restore('s1', project, 'a'.repeat(40))).rejects.toThrow(/no longer kept/)
    await expect(snaps.changes('s1', project, 'x', 'y')).rejects.toThrow(/Invalid checkpoint/)
    await expect(snaps.take('../evil', project)).rejects.toThrow(/Invalid session/)
  })

  it('keeps each session’s checkpoints apart, and forgets them when asked', async () => {
    put('a.txt', 'one\n')
    const mine = await snaps.take('s1', project)
    // Different content: an identical folder saved in the same second would give both sessions the very same commit id.
    put('b.txt', 'two')
    await snaps.take('s2', project)
    await expect(snaps.restore('s2', project, mine)).rejects.toThrow(/no longer kept/)

    snaps.forget('s1')
    expect(existsSync(join(data, 'snapshots', 's1.git'))).toBe(false)
    expect(existsSync(join(data, 'snapshots', 's2.git'))).toBe(true)
    await expect(snaps.restore('s1', project, mine)).rejects.toThrow(/no longer kept/)
    // Forgetting something that was never kept is not an error.
    snaps.forget('s9')
    snaps.forget('../x')
  })

  it('handles many saves at once, one after the other', async () => {
    put('a.txt', 'x')
    const ids = await Promise.all([1, 2, 3, 4, 5].map(() => snaps.take('s1', project)))
    expect(new Set(ids).size).toBe(5)
  })

  it('does not run hooks or use the person’s git settings', async () => {
    // A hook in the project’s own repository, and a global-style setting that would break a save, must not matter.
    git(project, 'init', '-q')
    mkdirSync(join(project, '.git', 'hooks'), { recursive: true })
    put('.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n')
    put('a.txt', 'x')
    await expect(snaps.take('s1', project)).resolves.toMatch(/^[0-9a-f]{40}$/)
  })
})
