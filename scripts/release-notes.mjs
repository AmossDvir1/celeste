// Prints the section of CHANGELOG.md for a version, to use as the notes of a release.   node scripts/release-notes.mjs 1.0.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const version = process.argv[2]
if (!version) {
  console.error('Say which version.')
  process.exit(2)
}
const log = readFileSync(join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')
// A heading is "## [1.0.0] - date": compare it as text, so that no character of the version is taken as a pattern.
const lines = log.split('\n')
const heading = (line) => line.startsWith('## ')
const at = lines.findIndex((line) => heading(line) && line.slice(3).replace(/^\[/, '').split(/[\] ]/)[0] === version)
if (at < 0) {
  console.error(`CHANGELOG.md has no section for ${version}.`)
  process.exit(1)
}
const next = lines.findIndex((line, i) => i > at && heading(line))
process.stdout.write(`${lines.slice(at + 1, next < 0 ? undefined : next).join('\n').trim()}\n`)
