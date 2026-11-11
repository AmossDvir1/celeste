import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, type Session } from 'electron'
import { VIEWER_MAX_BYTES } from '@shared/preview'

/*
 * `celeste-view://app/...` (docs/FILE_VIEWER_PLAN.md, section 4) answers two things only: the viewer page's own files, from the built app, and
 * `/__file/<token>/<name>`, the one file a viewer tab was opened with. A page of the browser cannot ask for anything else through it: the
 * path is checked here, and no path on the computer can be named, only a token that was made for that tab.
 */
export const VIEW_SCHEME = 'celeste-view'

/** What a request is for. */
export type ViewerTarget = { kind: 'file'; path: string } | { kind: 'app'; path: string } | { kind: 'none' }

/** What of the built app the viewer may fetch. */
const APP_FILES = /^(viewer\.html|assets\/[\w.\-@]+\.(js|css|woff2?|svg|png|wasm|json))$/i
const TOKEN = /^[0-9a-f]{32}$/

/** Decides what a request is for, without touching the disk. `fileOf` gives the file a token was made for, or null. */
export function routeViewerRequest(rawUrl: string, appDir: string, fileOf: (token: string) => string | null): ViewerTarget {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: 'none' }
  }
  if (url.protocol !== `${VIEW_SCHEME}:` || url.hostname !== 'app') return { kind: 'none' }
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return { kind: 'none' }
  }
  if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..') || path.split('/').includes('.')) return { kind: 'none' }
  if (path.startsWith('/__file/')) {
    const parts = path.split('/')
    const token = parts[2] ?? ''
    if (parts.length !== 4 || !TOKEN.test(token)) return { kind: 'none' }
    const file = fileOf(token)
    return file ? { kind: 'file', path: file } : { kind: 'none' }
  }
  const relative = path.replace(/^\//, '')
  if (!APP_FILES.test(relative)) return { kind: 'none' }
  const target = resolve(appDir, relative)
  return target.startsWith(resolve(appDir) + sep) ? { kind: 'app', path: target } : { kind: 'none' }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

/**
 * What the viewer page may do: run its own scripts, read the one file it was opened with, and draw. It cannot call out, load anything from
 * the web, or reach the rest of the computer.
 */
export const VIEWER_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' celeste-view: data: blob:; font-src 'self' data:; connect-src celeste-view:; media-src celeste-view: blob:"

export interface ViewerProtocolOptions {
  /** The built renderer, where `viewer.html` and its assets are. */
  appDir: string
  /** While developing, the dev server answers for the viewer's own files. */
  devUrl?: string | undefined
  fileOf: (token: string) => string | null
}

const notFound = () => new Response('Not found', { status: 404 })

/** Starts answering `celeste-view://` in a session. */
export function serveViewer(ses: Session, options: ViewerProtocolOptions): void {
  ses.protocol.handle(VIEW_SCHEME, async (request) => {
    const target = routeViewerRequest(request.url, options.appDir, options.fileOf)
    try {
      if (target.kind === 'file') {
        const info = await stat(target.path)
        if (!info.isFile() || info.size > VIEWER_MAX_BYTES) return new Response('Too large', { status: 413 })
        return await net.fetch(pathToFileURL(target.path).toString())
      }
      if (target.kind === 'app') {
        if (options.devUrl) return await net.fetch(new URL(new URL(request.url).pathname, options.devUrl).toString())
        const body = await readFile(target.path)
        const headers: Record<string, string> = { 'content-type': TYPES[extname(target.path).toLowerCase()] ?? 'application/octet-stream' }
        if (target.path.toLowerCase().endsWith('.html')) headers['content-security-policy'] = VIEWER_CSP
        return new Response(new Uint8Array(body), { headers })
      }
    } catch {
      return notFound()
    }
    return notFound()
  })
}
