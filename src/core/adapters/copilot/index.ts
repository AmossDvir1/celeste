import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk'
import type { AdapterContext } from '../types'
import { CopilotHost, type LoginSession, type RuntimeSource, type SdkClientHandle } from './host'
import { downloadRuntime, findRuntime } from './runtime'
import { CopilotAgentSession } from './session'

export { CopilotHost } from './host'

/**
 * Where Copilot's program comes from: one installed beside the SDK (development), or the one Celeste downloads
 * into its own data folder the first time someone connects.
 */
export function copilotRuntime(dataDir: string, installedAt: string[] = []): RuntimeSource {
  return {
    find: () => findRuntime({ dataDir, installedAt }),
    download: (onProgress, signal) => downloadRuntime({ dataDir, onProgress, signal })
  }
}

function handle(client: CopilotClient): SdkClientHandle {
  const sdk = client as unknown as SdkClientHandle
  return Object.assign(sdk, {
    // Signing in happens inside a session that never talks to a model, so it can refuse everything.
    createLoginSession: () => client.createSession({ onPermissionRequest: () => ({ kind: 'reject' }) }) as unknown as Promise<LoginSession>
  })
}

/**
 * The real runtime, from the SDK. The GitHub account signed in on this computer is the one it uses.
 * `isolatedDir` is for tests: the runtime then keeps its data there and knows no one, whoever is signed in on this computer.
 */
export function createCopilotHost(runtime?: RuntimeSource, options: { isolatedDir?: string } = {}): CopilotHost {
  const isolated = options.isolatedDir
    ? { baseDirectory: options.isolatedDir, useLoggedInUser: false, env: { ...process.env, COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' } }
    : {}
  return new CopilotHost(
    (path) => handle(new CopilotClient({ logLevel: 'error', ...isolated, ...(path ? { connection: RuntimeConnection.forStdio({ path }) } : {}) })),
    runtime
  )
}

export function createCopilotSession(
  host: CopilotHost,
  ctx: AdapterContext,
  deviceServer?: (sessionId: string) => { url: string; token: string } | undefined
): CopilotAgentSession {
  return new CopilotAgentSession({
    ctx,
    client: () => host.ready(),
    resolveModel: (model, effort) => host.resolve(model, effort),
    ...(deviceServer ? { deviceServer: () => deviceServer(ctx.sessionId) } : {})
  })
}
