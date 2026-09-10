const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plaudDesktop', {
  available: true,
  signIn: () => ipcRenderer.invoke('plaud:sign-in'),
  listLibrary: (options) => ipcRenderer.invoke('plaud:list-library', options || {}),
  openPdf: (base64, fileName) => ipcRenderer.invoke('desktop:open-pdf', { base64, fileName }),
  printHtml: (html, fileName) => ipcRenderer.invoke('desktop:print-html', { html, fileName }),
});
