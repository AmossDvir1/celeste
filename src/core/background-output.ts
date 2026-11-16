import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'

/*
 * Showing the output of a command the assistant started in the background. Claude Code writes it to a file of its own and tells Celeste
 * where (in the events `background.output` and `background.finished`). The window never names a path: it names a chat and a command, and
 * Core finds the path in what that chat's log says, checks it looks like such a file, and reads the end of it.
 */

/** The most of a command's output shown. A dev server can write for hours; the end is what matters. */
export const OUTPUT_TAIL = 64 * 1024

/** What Claude Code's output files look like: an absolute path to `<id>.output` inside a folder called `tasks`. Nothing else is read. */
export function isOutputFile(path: unknown): path is string {
  return typeof path === 'string' && path.length < 1000 && isAbsolute(path) && path.endsWith('.output') && basename(dirname(path)) === 'tasks' && !path.split(/[\\/]/).includes('..')
}

/** The output file of a command, from a log: the newest event about that command that names one. */
export function outputFileFor(events: Iterable<{ event: { type: string; taskId?: string; outputFile?: string } }>, taskId: string): string | undefined {
  let found: string | undefined
  for (const { event } of events) {
    if ((event.type === 'background.output' || event.type === 'background.finished') && event.taskId === taskId && event.outputFile) found = event.outputFile
  }
  return found
}

/** The last part of a file as text. A cut that lands inside a line drops that line's start. Throws a sentence when it cannot be read. */
export function readTail(path: string, max = OUTPUT_TAIL): { text: string; truncated: boolean } {
  if (!isOutputFile(path)) throw new Error('That is not a file Celeste shows.')
  let fd: number | undefined
  try {
    // Not a link: a command could make its output file point somewhere else.
    if (!lstatSync(path).isFile()) throw new Error('not a plain file')
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, max)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    let text = buffer.toString('utf8')
    const truncated = size > max
    if (truncated) text = text.slice(text.indexOf('\n') + 1)
    return { text, truncated }
  } catch {
    throw new Error('The output is not there any more.')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
