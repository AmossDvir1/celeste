// A stand-in for the npm registry on this computer, for checks of the first-Connect download. It serves the Claude Code program that
// `npm install` already put beside the SDK, packed the way npm packs it, so what is downloaded and run is the real program.
// The app is pointed at it with CELESTE_NPM_REGISTRY (see `env`). Nothing leaves this computer.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { root } from './app.mjs'

const version = JSON.parse(readFileSync(join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version
const platform = `${process.platform}-${process.arch}`
const packageName = `claude-agent-sdk-${platform}`

/** The platform package as an npm tarball. Made once and kept in scripts/.output, because packing 330 MB takes a while. */
async function packed() {
  const out = join(root, 'scripts', '.output')
  const file = join(out, `${packageName}-${version}.tgz`)
  if (existsSync(file) && statSync(file).size > 1_000_000) return file
  const source = join(root, 'node_modules', '@anthropic-ai', packageName)
  if (!existsSync(source)) throw new Error(`The Claude Code program is not installed beside the SDK (${source}). Run npm install first.`)
  mkdirSync(out, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'celeste-registry-'))
  try {
    cpSync(source, join(work, 'package'), { recursive: true })
    // Relative names and the folder as the working directory: a drive letter (C:) is taken for a host name by some tars.
    execFileSync('tar', ['-cf', 'package.tar', 'package'], { cwd: work, stdio: 'inherit' })
    // Level 1: the file is only ever read by this computer, and speed matters more than size.
    await pipeline(createReadStream(join(work, 'package.tar')), createGzip({ level: 1 }), createWriteStream(`${file}.partial`))
    renameSync(`${file}.partial`, file)
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
  return file
}

async function integrity(file) {
  const hash = createHash('sha512')
  await pipeline(createReadStream(file), hash)
  return `sha512-${hash.digest('base64')}`
}

/**
 * Starts the stand-in registry. `env` goes to the app. `requests` lists what was asked for, so a check can see that the download
 * happened (or did not). `corrupt: true` serves the right file under a wrong checksum.
 */
export async function startRegistry({ corrupt = false } = {}) {
  const file = await packed()
  const sum = corrupt ? `sha512-${Buffer.alloc(64).toString('base64')}` : await integrity(file)
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.url)
    if (req.url?.includes(`claude-agent-sdk-${platform}/${version}`)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ dist: { tarball: `http://127.0.0.1:${server.address().port}/program.tgz`, integrity: sum } }))
    } else if (req.url === '/program.tgz') {
      res.writeHead(200, { 'content-length': String(statSync(file).size) })
      createReadStream(file).pipe(res)
    } else res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    requests,
    version,
    platform,
    env: {
      CELESTE_NPM_REGISTRY: url,
      // The program beside the SDK is hidden from the app, so that what it uses is what it downloaded.
      CELESTE_CLAUDE_NO_INSTALLED: '1'
    },
    stop: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
    /** Where the app puts a downloaded program, under its data folder. */
    downloadedIn: (dataDir) => join(dataDir, 'runtimes', `claude-${version}-${platform}`)
  }
}
