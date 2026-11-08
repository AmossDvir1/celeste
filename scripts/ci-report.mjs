// Runs one npm script (or, with --raw, any command) and, when it fails, also writes the lines that matter as a GitHub Actions annotation, so
// the reason can be read from the run's page without opening the log.
//   node scripts/ci-report.mjs verify:ui          node scripts/ci-report.mjs --raw npm ci
import { spawn } from 'node:child_process'

const raw = process.argv[2] === '--raw'
const args = process.argv.slice(raw ? 3 : 2)
const script = args.join(' ')
if (!script) {
  console.error('Say which npm script (or, with --raw, which command) to run.')
  process.exit(2)
}

const lines = []
const win = process.platform === 'win32'
const child = raw
  ? spawn(script, { stdio: ['ignore', 'pipe', 'pipe'], shell: true })
  : spawn(win ? 'npm.cmd' : 'npm', ['run', script], { stdio: ['ignore', 'pipe', 'pipe'], shell: win })
const take = (stream, out) => {
  let rest = ''
  stream.on('data', (chunk) => {
    out.write(chunk)
    const parts = (rest + chunk.toString('utf8')).split('\n')
    rest = parts.pop() ?? ''
    lines.push(...parts)
  })
  stream.on('end', () => rest && lines.push(rest))
}
take(child.stdout, process.stdout)
take(child.stderr, process.stderr)

child.on('close', (code) => {
  if (code === 0) process.exit(0)
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
  // The lines that say what failed, and for an accessibility audit which rule, where, and why.
  const wanted = plain.filter((l, i) => /^(FAIL|failed|\d+ failed)|Error|Timed out|waiting for|Call log|✘|Timeout|\((serious|critical|moderate|minor)\)|^\s+\[|Element has|must |should |^npm (error|ERR!)/.test(l) || (i > 0 && /^(FAIL|Error)/.test(plain[i - 1] ?? '')))
  const body = (wanted.length ? wanted : plain.slice(-25)).slice(-30).join('\n').slice(-3500)
  const escape = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  console.log(`::error title=${escape(script)} failed::${escape(body)}`)
  process.exit(code ?? 1)
})
