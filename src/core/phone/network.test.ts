import { describe, expect, it } from 'vitest'
import { PROFILE_SCRIPT, checkNetwork, networkWarning } from './network'

describe('the network phones reach Celeste on', () => {
  it('warns about a Public network only, naming it', () => {
    expect(networkWarning('Private', 'Home')).toBeNull()
    expect(networkWarning('DomainAuthenticated', 'Work')).toBeNull()
    expect(networkWarning(null, null)).toBeNull()
    expect(networkWarning('Public', 'Home Wi-Fi')).toMatch(/^Windows treats this network \(“Home Wi-Fi”\) as Public.*Private network\.$/)
    expect(networkWarning('Public', '')).toMatch(/^Windows treats this network as Public/)
  })

  it('asks only on Windows, and puts nothing but an address into the script', async () => {
    expect(await checkNetwork('192.168.1.5', 'linux')).toBeNull()
    expect(await checkNetwork(undefined, 'win32')).toBeNull()
    // Only the characters of an address survive: no quote, space or semicolon can end the string and add a command.
    const quoted = /-IPAddress '([^']*)'/.exec(PROFILE_SCRIPT("192.168.1.5'; Remove-Item C:\\ -Recurse; '"))?.[1]
    expect(quoted).toMatch(/^[0-9a-fA-F.:]+$/)
  })
})
