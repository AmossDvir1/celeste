import { describe, expect, it } from 'vitest'
import { contentTypeFor, extensionOf, fileAddress, fileTitle, previewInfo } from './preview'

describe('how a file is shown', () => {
  it('lets Chromium show what it can', () => {
    for (const name of ['a.pdf', 'p.PNG', 'p.jpg', 'p.jpeg', 'p.gif', 'p.webp', 'p.avif', 'p.svg', 'v.mp4', 'v.webm', 'v.mov', 'v.mkv', 'a.mp3', 'a.flac', 'a.m4a', 'page.html', 'page.HTM']) {
      expect(previewInfo(name).how, name).toBe('native')
    }
  })

  it('sends Office files and other documents to the viewer, each to its own view', () => {
    const views: Record<string, string> = {
      'a.docx': 'docx', 'a.xlsx': 'sheet', 'a.xlsm': 'sheet', 'a.xls': 'sheet', 'a.ods': 'sheet', 'a.csv': 'sheet', 'a.tsv': 'sheet', 'a.pptx': 'pptx',
      'a.odt': 'opendoc', 'a.odp': 'opendoc', 'a.rtf': 'rtf', 'a.md': 'markdown', 'a.markdown': 'markdown', 'a.ipynb': 'notebook', 'a.json': 'json',
      'a.zip': 'zip', 'a.txt': 'code', 'a.yaml': 'code', 'a.ts': 'code', 'a.py': 'code', 'a.sql': 'code', 'a.log': 'code'
    }
    for (const [name, view] of Object.entries(views)) expect(previewInfo(name), name).toMatchObject({ how: 'viewer', view })
  })

  it('knows a file by its last extension and is not fooled by case, folders or dots in the name', () => {
    expect(previewInfo('C:\\Users\\Dana\\Report.Final.v2.DOCX')).toMatchObject({ how: 'viewer', view: 'docx' })
    expect(previewInfo('/home/dana/my.dir/notes')).toMatchObject({ how: 'card' })
    expect(previewInfo('.gitignore')).toMatchObject({ how: 'viewer', view: 'code' })
    expect(previewInfo('.env')).toMatchObject({ how: 'viewer', view: 'code' })
    expect(previewInfo('.secret')).toMatchObject({ how: 'card' })
    expect(extensionOf('a.tar.gz')).toBe('gz')
    expect(extensionOf('.hidden')).toBe('')
    expect(extensionOf('noext')).toBe('')
  })

  it('treats a few names with no extension as text', () => {
    for (const name of ['Dockerfile', 'Makefile', 'LICENSE', 'README']) expect(previewInfo(name), name).toMatchObject({ how: 'viewer', view: 'code' })
  })

  it('says why the formats it knows and cannot show are not shown, and never offers to start a program', () => {
    expect(previewInfo('old.doc')).toMatchObject({ how: 'card', note: expect.stringContaining('.docx') })
    expect(previewInfo('old.ppt')).toMatchObject({ how: 'card', note: expect.stringContaining('.pptx') })
    expect(previewInfo('photo.heic')).toMatchObject({ how: 'card' })
    expect(previewInfo('movie.avi')).toMatchObject({ how: 'card' })
    for (const name of ['setup.exe', 'run.bat.lnk', 'tool.msi', 'a.app', 'mystery.bin', 'file.unknownext']) expect(previewInfo(name).how, name).toBe('card')
  })

  it('gives a card a label even for an unknown type', () => {
    expect(previewInfo('x.weird')).toEqual({ how: 'card', label: 'WEIRD file' })
    expect(previewInfo('x')).toEqual({ how: 'card', label: 'File' })
  })
})

describe('addresses and names', () => {
  it('makes an address Chromium opens, from a path of either kind', () => {
    expect(fileAddress('C:\\Users\\Dana\\my notes\\a b.pdf')).toBe('file:///C:/Users/Dana/my%20notes/a%20b.pdf')
    expect(fileAddress('/home/dana/a#1.pdf')).toBe('file:///home/dana/a%231.pdf')
    expect(fileAddress('D:/x/é.png')).toBe('file:///D:/x/%C3%A9.png')
  })

  it('names a tab after the file', () => {
    expect(fileTitle('C:\\a\\b\\report.docx')).toBe('report.docx')
    expect(fileTitle('/a/b/c.md')).toBe('c.md')
    expect(fileTitle('plain')).toBe('plain')
  })

  it('has a content type for the common ones and a plain one for the rest', () => {
    expect(contentTypeFor('a.pdf')).toBe('application/pdf')
    expect(contentTypeFor('a.PNG')).toBe('image/png')
    expect(contentTypeFor('a.docx')).toBe('application/octet-stream')
  })
})
