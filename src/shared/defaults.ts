import type { AppSettings, VendorRecords } from './api'

/** What a new installation starts with. Core fills in the user name and projects folder from the operating system. */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  userName: 'there',
  wizardDone: false,
  sidebarCollapsed: false,
  defaults: { model: 'copilot-auto', approval: 'auto', projectsFolder: '' }
}

/** The preview starts with two vendors shown as connected so every screen has something to show. */
export const DEFAULT_VENDORS: VendorRecords = {
  copilot: { account: 'amoss on GitHub', method: 'browser' },
  claude: { account: 'Console · Amoss Labs', method: 'browser' }
}
