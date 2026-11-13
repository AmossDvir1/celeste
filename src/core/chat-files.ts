import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** Session ids are `s-` and a UUID. Anything else is not a folder of ours. */
const SESSION_ID = /^s-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A file the agent made in a chat's private folder, named by the window as a session and a path inside that folder. The window is
 * not trusted to name any other file: the path must stay inside the folder after links are followed, and must be a plain file.
 */
export function resolveChatFile(dataDir: string, sessionId: unknown, relative: unknown): { file: string } | { error: string } {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { error: 'That is not a chat.' }
  if (typeof relative !== 'string' || relative === '' || relative.includes('\0') || isAbsolute(relative) || relative.split(/[\/]/).includes('..')) {
    return { error: 'That is not a file in this chat.' }
  }
  try {
    const base = realpathSync(join(dataDir, 'chats', sessionId))
    const file = realpathSync(resolve(base, relative))
    if (!file.startsWith(base + sep) || !lstatSync(file).isFile()) return { error: 'That is not a file in this chat.' }
    return { file }
  } catch {
    return { error: 'The file is no longer there.' }
  }
}
