import { execFile } from 'node:child_process'

/*
 * Windows treats each network as Private or Public, and its firewall blocks other devices from reaching a program on a
 * Public one. A home Wi-Fi left as Public (Windows' default for a new network) is the commonest reason a phone cannot
 * find Celeste, so Settings, Phone says so, with how to change it. Other systems have nothing like it to check.
 */

/** What Settings, Phone says about a network category, or null when there is nothing to say. */
export function networkWarning(category: string | null, name: string | null): string | null {
  if (category?.trim().toLowerCase() !== 'public') return null
  const which = name?.trim() ? `this network (“${name.trim()}”)` : 'this network'
  return `Windows treats ${which} as Public, and its firewall may then keep phones from reaching Celeste (unless Celeste was allowed on public networks). If your phone cannot connect and this is your home Wi-Fi, set it to Private: Windows Settings › Network & internet › Wi-Fi (or Ethernet) › the network › Private network.`
}

/** The script: the network the address is on, and whether Windows calls it Private or Public. Read-only, needs no admin. */
export const PROFILE_SCRIPT = (address: string) =>
  `$ErrorActionPreference='Stop'; $i=(Get-NetIPAddress -IPAddress '${address.replace(/[^0-9a-fA-F.:]/g, '')}').InterfaceIndex; $p=Get-NetConnectionProfile -InterfaceIndex $i; "$($p.NetworkCategory)|$($p.Name)"`

/** Asks Windows about the network `address` is on. Null on other systems, or when Windows cannot tell. */
export function checkNetwork(address: string | undefined, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform !== 'win32' || !address) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROFILE_SCRIPT(address)], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const [category, ...name] = String(stdout).trim().split('|')
      resolve(networkWarning(category ?? null, name.join('|') || null))
    })
  })
}
