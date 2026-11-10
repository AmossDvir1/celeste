const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('spike', { rect: (r) => ipcRenderer.send('rect', r) })
