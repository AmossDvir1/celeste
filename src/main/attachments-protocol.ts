import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, net, protocol } from 'electron'
import { VIEW_SCHEME } from './viewer/protocol'

/**
 * `celeste-file://attachments/<id>.<ext>` shows an attached file in the window. It serves the attachments
 * folder and nothing else, so the window never needs file access of its own.
 */
const SCHEME = 'celeste-file'
const FILE = /^[\w-]+\.[a-z0-9]{1,5}$/

/** Must run before the app is ready. */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    // The viewer's pages and the file each viewer tab was opened with (see viewer/protocol.ts).
    { scheme: VIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

export function serveAttachments(): void {
  const dir = resolve(join(app.getPath('userData'), 'attachments'))
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    const name = decodeURIComponent(url.pathname.slice(1))
    const target = resolve(join(dir, name))
    if (url.hostname !== 'attachments' || !FILE.test(name) || !target.startsWith(dir + sep)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}
