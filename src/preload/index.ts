import { contextBridge, ipcRenderer } from 'electron'

const api = {
  platform: process.platform,
  setTheme: (payload: { color: string; symbolColor: string }): void => {
    ipcRenderer.send('celeste:theme', payload)
  }
}

contextBridge.exposeInMainWorld('celeste', api)
