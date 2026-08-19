const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plaudDesktop', {
  available: true,
  signIn: () => ipcRenderer.invoke('plaud:sign-in'),
});
