import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { routeViewerRequest } from './protocol'

const APP = resolve('/app/renderer')
const TOKEN = 'a'.repeat(32)
const files: Record<string, string> = { [TOKEN]: '/data/report.docx' }
const route = (url: string) => routeViewerRequest(url, APP, (t) => files[t] ?? null)

describe('what the viewer scheme answers', () => {
  it('serves the viewer page and its assets from the built app', () => {
    expect(route('celeste-view://app/viewer.html?t=1')).toEqual({ kind: 'app', path: resolve(APP, 'viewer.html') })
    expect(route('celeste-view://app/assets/index-AbC123.js')).toEqual({ kind: 'app', path: resolve(APP, 'assets/index-AbC123.js') })
    expect(route('celeste-view://app/assets/font-x.woff2')).toMatchObject({ kind: 'app' })
  })

  it('serves the one file a token was made for, and no other', () => {
    expect(route(`celeste-view://app/__file/${TOKEN}/report.docx`)).toEqual({ kind: 'file', path: '/data/report.docx' })
    expect(route(`celeste-view://app/__file/${'b'.repeat(32)}/report.docx`)).toEqual({ kind: 'none' })
    expect(route('celeste-view://app/__file/short/report.docx')).toEqual({ kind: 'none' })
    expect(route(`celeste-view://app/__file/${TOKEN}`)).toEqual({ kind: 'none' })
    expect(route(`celeste-view://app/__file/${TOKEN}/a/b.docx`)).toEqual({ kind: 'none' })
    expect(route(`celeste-view://app/__file/${TOKEN.toUpperCase()}/x`)).toEqual({ kind: 'none' })
  })

  it('refuses a path that climbs, a name with a back slash, and anything of the app that is not the viewer’s', () => {
    for (const url of [
      'celeste-view://app/../main/index.js',
      'celeste-view://app/assets/../../main/index.js',
      'celeste-view://app/%2e%2e/main/index.js',
      'celeste-view://app/assets/..%2f..%2fmain%2findex.js',
      'celeste-view://app/assets\\x.js',
      'celeste-view://app/index.html',
      'celeste-view://app/assets/secret.txt',
      'celeste-view://app/assets/x.js.map',
      'celeste-view://app/viewer.html%00.png',
      'celeste-view://app/',
      'celeste-view://app/assets/'
    ]) {
      expect(route(url), url).toEqual({ kind: 'none' })
    }
  })

  it('answers only for the host app of its own scheme', () => {
    expect(route('celeste-view://other/viewer.html')).toEqual({ kind: 'none' })
    expect(route('https://app/viewer.html')).toEqual({ kind: 'none' })
    expect(route('celeste-file://app/viewer.html')).toEqual({ kind: 'none' })
    expect(route('not a url')).toEqual({ kind: 'none' })
  })
})
