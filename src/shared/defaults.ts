import type { AppSettings } from './api'

/** The session list can be dragged between these widths (the default, a third narrower and half as wide again). */
export const SIDEBAR_WIDTH = { min: 192, default: 232, max: 348 } as const

/** What a new installation starts with. Core fills in the user name from the operating system. */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  userName: 'there',
  wizardDone: false,
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH.default,
  desktopControl: false,
  desktopNeverApps: [],
  browserTools: true,
  browserAllowedSites: [],
  pinnedModels: [],
  defaults: { model: 'copilot-auto', approval: 'auto' }
}

