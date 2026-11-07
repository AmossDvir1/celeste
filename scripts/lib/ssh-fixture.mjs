// A small SSH server for tests: password or key sign-in, a few made-up commands, and real SFTP over a folder.
// It stands in for a VM, so the device code can be tested without one. It can pose as Linux or as Windows.
import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync, writeSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, sep } from 'node:path'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const { STATUS_CODE, flagsToString } = utils.sftp

const fingerprintOf = (publicKey) =>
  `SHA256:${createHash('sha256').update(utils.parseKey(publicKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}`

/**
 * Starts the server on a free local port.
 * options.port: reuse a port, for example to come back with a new host key. options.os: 'linux' (default) or 'windows'. options.users: { name: password }. options.authorizedKey: an OpenSSH public key.
 */
export async function startSshFixture(options = {}) {
  const os = options.os ?? 'linux'
  const users = options.users ?? { dev: 'secret' }
  const authorized = options.authorizedKey ? utils.parseKey(options.authorizedKey) : null
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'celeste-ssh-'))
  const hostKey = utils.generateKeyPairSync('ed25519')
  const commands = []
  const sockets = new Set()
  let connections = 0

  const local = (remote) => {
    const p = normalize(join(root, ...remote.replace(/\\/g, '/').split('/').filter(Boolean)))
    if (p !== root && !p.startsWith(root + sep)) throw new Error('outside the root')
    return p
  }
  const attrsOf = (st) => ({ mode: st.mode, uid: 0, gid: 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) })

  function runCommand(command, stream) {
    commands.push(command)
    const finish = (code) => {
      stream.exit(code)
      stream.end()
    }
    let script = null
    const encoded = /^powershell -NoProfile -NonInteractive -EncodedCommand (\S+)$/.exec(command)
    if (encoded) {
      script = Buffer.from(encoded[1], 'base64').toString('utf16le').replace(/^.*?OutputEncoding=\[Text\.Encoding\]::UTF8;/, '')
      commands[commands.length - 1] = `powershell: ${script}`
    }
    if (os === 'windows' && !encoded) {
      stream.stderr.write(`'${command.split(' ')[0]}' is not recognized as an internal or external command.\r\n`)
      return finish(1)
    }
    if (encoded && os !== 'windows') {
      stream.stderr.write('powershell: command not found\n')
      return finish(127)
    }
    const text = script ?? command
    let m
    if (text === 'uname -s && whoami && hostname') {
      stream.write('Linux\nfixture-user\nfixture-host\n')
      return finish(0)
    }
    if (text === 'uname -a; df -h /') {
      stream.write('Linux fixture-host 6.8.0 x86_64 GNU/Linux\nFilesystem  Size  Used Avail Use% Mounted on\n/dev/sda1    80G   31G   45G  41% /\n')
      return finish(0)
    }
    if (text.startsWith("'windows';")) {
      stream.write('windows\r\nfixture-user\r\nWIN-FIXTURE\r\n')
      return finish(0)
    }
    if ((m = /^(?:echo|Write-Output) (.*)$/.exec(text))) {
      stream.write(`${m[1]}\n`)
      return finish(0)
    }
    if (text === 'fail') {
      stream.stderr.write('boom\n')
      return finish(3)
    }
    if (text === 'throw') {
      stream.stderr.write('#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">nope_x000D__x000A_</S></Objs>')
      return finish(1)
    }
    if ((m = /^big (\d+)$/.exec(text))) {
      const total = Number(m[1])
      let sent = 0
      while (sent < total) {
        const n = Math.min(8192, total - sent)
        stream.write(Buffer.alloc(n, sent === 0 ? 'S' : sent + n >= total ? 'E' : 'x'))
        sent += n
      }
      return finish(0)
    }
    if ((m = /^sleep (\d+)$/.exec(text))) {
      const timer = setTimeout(() => finish(0), Number(m[1]))
      stream.once('close', () => clearTimeout(timer))
      return
    }
    stream.stderr.write(`${text.split(' ')[0]}: command not found\n`)
    return finish(127)
  }

  function sftpSession(sftp) {
    const handles = new Map()
    let next = 1
    const newHandle = (value) => {
      const id = Buffer.alloc(4)
      id.writeUInt32BE(next++)
      handles.set(id.readUInt32BE(0), value)
      return id
    }
    const get = (h) => handles.get(h.readUInt32BE(0))
    const fail = (reqid, err) => sftp.status(reqid, err?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE)

    sftp.on('REALPATH', (reqid, path) => sftp.name(reqid, [{ filename: path, longname: path, attrs: {} }]))
    const stat = (reqid, path) => {
      try {
        sftp.attrs(reqid, attrsOf(statSync(local(path))))
      } catch (err) {
        fail(reqid, err)
      }
    }
    sftp.on('STAT', stat)
    sftp.on('LSTAT', stat)
    sftp.on('FSTAT', (reqid, h) => {
      const f = get(h)
      if (f?.fd !== undefined) sftp.attrs(reqid, attrsOf(fstatSync(f.fd)))
      else sftp.status(reqid, STATUS_CODE.FAILURE)
    })
    sftp.on('OPENDIR', (reqid, path) => {
      try {
        const dir = local(path)
        const entries = readdirSync(dir).map((name) => {
          const st = statSync(join(dir, name))
          return { filename: name, longname: name, attrs: attrsOf(st) }
        })
        sftp.handle(reqid, newHandle({ entries, sent: false }))
      } catch (err) {
        fail(reqid, err)
      }
    })
    sftp.on('READDIR', (reqid, h) => {
      const d = get(h)
      if (!d || d.sent) return sftp.status(reqid, STATUS_CODE.EOF)
      d.sent = true
      if (d.entries.length === 0) return sftp.status(reqid, STATUS_CODE.EOF)
      sftp.name(reqid, d.entries)
    })
    sftp.on('OPEN', (reqid, filename, flags) => {
      try {
        const path = local(filename)
        if (flagsToString(flags).includes('w')) mkdirSync(join(path, '..'), { recursive: true })
        sftp.handle(reqid, newHandle({ fd: openSync(path, flagsToString(flags)) }))
      } catch (err) {
        fail(reqid, err)
      }
    })
    sftp.on('READ', (reqid, h, offset, length) => {
      const f = get(h)
      const buf = Buffer.alloc(length)
      const n = readSync(f.fd, buf, 0, length, offset)
      if (n === 0) sftp.status(reqid, STATUS_CODE.EOF)
      else sftp.data(reqid, buf.subarray(0, n))
    })
    sftp.on('WRITE', (reqid, h, offset, data) => {
      writeSync(get(h).fd, data, 0, data.length, offset)
      sftp.status(reqid, STATUS_CODE.OK)
    })
    sftp.on('CLOSE', (reqid, h) => {
      const f = get(h)
      if (f?.fd !== undefined) closeSync(f.fd)
      handles.delete(h.readUInt32BE(0))
      sftp.status(reqid, STATUS_CODE.OK)
    })
  }

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    connections++
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && users[ctx.username] !== undefined && users[ctx.username] === ctx.password) return ctx.accept()
      if (ctx.method === 'publickey' && authorized && ctx.key.algo === authorized.type) {
        const same = ctx.key.data.length === authorized.getPublicSSH().length && timingSafeEqual(ctx.key.data, authorized.getPublicSSH())
        if (same && (!ctx.signature || authorized.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) return ctx.accept()
      }
      ctx.reject(['password', 'publickey'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => runCommand(info.command, acceptExec()))
        session.on('sftp', (acceptSftp) => sftpSession(acceptSftp()))
      })
    })
    client.on('error', () => undefined)
  })
  // The server hands over SSH connections, not raw sockets. Reach the socket underneath to cut it dead.
  const kill = (c) => (c._sock?.destroy ? c._sock.destroy() : c.end())
  server.on('connection', (client) => {
    sockets.add(client)
    client.once('close', () => sockets.delete(client))
  })

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    host: '127.0.0.1',
    port,
    root,
    get fingerprint() {
      return fingerprintOf(hostKey.public)
    },
    get commands() {
      return commands
    },
    get connections() {
      return connections
    },
    /** Drops every open connection, as a Wi-Fi drop would. */
    dropConnections() {
      sockets.forEach(kill)
    },
    async close() {
      sockets.forEach(kill)
      await new Promise((resolve) => server.close(resolve))
      if (!options.root) rmSync(root, { recursive: true, force: true })
    }
  }
}

/** A key pair for key sign-in tests. */
export function generateClientKey() {
  return utils.generateKeyPairSync('ed25519')
}
