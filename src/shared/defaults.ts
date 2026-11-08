import type { AppSettings } from './api'

/** What a new installation starts with. Core fills in the user name and projects folder from the operating system. */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  userName: 'there',
  wizardDone: false,
  sidebarCollapsed: false,
  pinnedModels: [],
  defaults: { model: 'copilot-auto', approval: 'auto', projectsFolder: '' }
}

