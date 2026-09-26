'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge between the sandboxed page and the main process.
contextBridge.exposeInMainWorld('desktop', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    onMaximizeChange: (callback) => {
      const listener = (_event, isMaximized) => callback(Boolean(isMaximized));
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    },
  },
  fs: {
    selectDirectory: () => ipcRenderer.invoke('fs:select-directory'),
    listDirectory: (dirPath) => ipcRenderer.invoke('fs:list-directory', dirPath),
    writeFile: (dirPath, fileName, data, overwrite = false) =>
      ipcRenderer.invoke('fs:write-file', { dirPath, fileName, data, overwrite }),
  },
});
