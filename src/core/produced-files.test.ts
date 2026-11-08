import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canOpenFile, fileKind, formatBytes } from '@shared/produced'
import { producedSince, scanFolder } from './produced-files'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'celeste-produced-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('finding what a turn made', () => {
  it('lists new files, in folders too, and leaves out hidden files and tool folders', () => {
    const before = scanFolder(dir)
    writeFileSync(join(dir, 'report.csv'), 'a,b\n1,2\n')
    mkdirSync(join(dir, 'out'))
    writeFileSync(join(dir, 'out', 'chart.png'), 'png')
    writeFileSync(join(dir, '.hidden'), 'x')
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'junk.js'), 'x')
    const made = producedSince(before, scanFolder(dir))
    expect(made.files).toEqual([
      { path: 'out/chart.png', size: 3, status: 'added' },
      { path: 'report.csv', size: 8, status: 'added' }
    ])
    expect(made.more).toBe(0)
  })

  it('says a file was changed when it was written again, and ignores one that was left alone', () => {
    writeFileSync(join(dir, 'keep.txt'), 'same')
    writeFileSync(join(dir, 'edit.txt'), 'old')
    const before = scanFolder(dir)
    writeFileSync(join(dir, 'edit.txt'), 'newer text')
    // The modification time can be too close to tell on a fast disk, so move it.
    utimesSync(join(dir, 'edit.txt'), new Date(), new Date(Date.now() + 5000))
    writeFileSync(join(dir, 'new.md'), '# hi')
    const made = producedSince(before, scanFolder(dir))
    expect(made.files.map((f) => [f.path, f.status])).toEqual([
      ['new.md', 'added'],
      ['edit.txt', 'modified']
    ])
  })

  it('finds nothing when nothing was written, and for a folder that is not there', () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    const before = scanFolder(dir)
    expect(producedSince(before, scanFolder(dir))).toEqual({ files: [], more: 0 })
    expect(scanFolder(join(dir, 'nope')).size).toBe(0)
  })

  it('lists at most twelve and says how many more there were', () => {
    const before = scanFolder(dir)
    for (let i = 0; i < 15; i++) writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.txt`), 'x')
    const made = producedSince(before, scanFolder(dir))
    expect(made.files).toHaveLength(12)
    expect(made.more).toBe(3)
  })
})

describe('what can be opened', () => {
  it('opens documents and nothing that could run', () => {
    for (const ok of ['report.pdf', 'notes.MD', 'data.csv', 'chart.png', 'page.html', 'slides.pptx', 'x.zip']) expect(canOpenFile(ok), ok).toBe(true)
    for (const no of ['setup.exe', 'run.bat', 'run.cmd', 'x.ps1', 'x.sh', 'x.js', 'x.py', 'x.lnk', 'x.msi', 'x.jar', 'x.url', 'x.scr', 'noextension', '.bashrc']) expect(canOpenFile(no), no).toBe(false)
  })
  it('names kinds and sizes', () => {
    expect(fileKind('a.PNG')).toBe('image')
    expect(fileKind('a.csv')).toBe('data')
    expect(fileKind('a.exe')).toBe('other')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
