import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  selectFile: () => ipcRenderer.invoke('dialog:selectFile'),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  showSaveDialog: (options: object) => ipcRenderer.invoke('dialog:showSave', options),
  getApiBase: () => 'http://localhost:8600',
  // Quit the whole app: closes the window AND (via before-quit) kills the
  // backend process. Used by the Settings "Shutdown" button in desktop mode.
  quitApp: () => ipcRenderer.invoke('app:quit'),
  // Native window handle (HWND decimal string) so the VST3 editor can be owned
  // by / pinned over the MIX area. Null off Electron / on failure.
  getNativeWindowHandle: () => ipcRenderer.invoke('window:getNativeHandle'),
  // Screen-space content-area bounds (DIP) for converting an element rect into
  // absolute screen pixels.
  getContentBounds: () => ipcRenderer.invoke('window:getContentBounds'),
  // Subscribe to OS file-open events (double-clicked .tasmo / .gan). Returns a
  // disposer so the renderer can unsubscribe (StrictMode-safe).
  onOpenFile: (cb: (filePath: string) => void) => {
    const handler = (_e: unknown, filePath: string) => cb(filePath)
    ipcRenderer.on('open-file', handler)
    return () => ipcRenderer.removeListener('open-file', handler)
  },
})
