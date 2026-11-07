import type { ConnectorFactory } from './connector'
import { AdbConnector, findAdb } from './adb-connector'
import { HyperVConnector } from './hyperv-connector'
import { SshConnector } from './ssh-connector'

/** Picks the way to reach a device from its kind. */
export function connectorsForApp(): ConnectorFactory {
  return (target, credentials, hooks) => {
    switch (target.kind) {
      case 'ssh':
        return new SshConnector(target, credentials)
      case 'hyperv':
        return new HyperVConnector(target, credentials)
      case 'adb':
        return new AdbConnector(target, findAdb(), undefined, hooks)
    }
  }
}
