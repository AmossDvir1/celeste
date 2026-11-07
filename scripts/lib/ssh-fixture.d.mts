export interface SshFixture {
  host: string
  port: number
  /** The folder SFTP serves. */
  root: string
  /** SHA256:... of the current host key. */
  readonly fingerprint: string
  /** Every command received, in order. */
  readonly commands: string[]
  readonly connections: number
  dropConnections(): void
  close(): Promise<void>
}

export function startSshFixture(options?: {
  os?: 'linux' | 'windows'
  users?: Record<string, string>
  authorizedKey?: string
  root?: string
  port?: number
}): Promise<SshFixture>

export function generateClientKey(): { private: string; public: string }
