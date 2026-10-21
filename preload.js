const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  loadPresets: () => ipcRenderer.invoke('load-presets'),
  savePresets: (p) => ipcRenderer.invoke('save-presets', p),
  snapWindow: (zone, displayIndex) => ipcRenderer.invoke('snap-window', zone, displayIndex),
  closeAssist: () => ipcRenderer.invoke('close-assist'),
  getWindows: () => ipcRenderer.invoke('get-windows'),
  snapWindowByHwnd: (hwnd, zone, displayIndex) => ipcRenderer.invoke('snap-window-by-hwnd', hwnd, zone, displayIndex),
  openHotkeys: () => ipcRenderer.invoke('open-hotkeys'),
  getHotkeys: () => ipcRenderer.invoke('get-hotkeys'),
  setHotkeys: (bindings) => ipcRenderer.invoke('set-hotkeys', bindings),
  suspendHotkeys: () => ipcRenderer.invoke('suspend-hotkeys'),
  resumeHotkeys: () => ipcRenderer.invoke('resume-hotkeys'),
});
