import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  selectFile: () => ipcRenderer.invoke('dialog:selectFile'),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  showSaveDialog: (options: object) => ipcRenderer.invoke('dialog:showSave', options),
  getApiBase: () => 'http://127.0.0.1:8600',
  // Quit the whole app: closes the window AND (via before-quit) kills the
  // backend process. Used by the Settings "Shutdown" button in desktop mode.
  quitApp: () => ipcRenderer.invoke('app:quit'),
  // Native window handle (HWND decimal string) so the VST3 editor can be owned
  // by / pinned over the MIX area. Null off Electron / on failure.
  getNativeWindowHandle: () => ipcRenderer.invoke('window:getNativeHandle'),
  // Screen-space content-area bounds (DIP) for converting an element rect into
  // absolute screen pixels.
  getContentBounds: () => ipcRenderer.invoke('window:getContentBounds'),
  // Monitors attached to this machine, for the pop-out screen choice in
  // Settings -> Inputs & outputs. Absent in a browser, which is what makes that
  // row render as "desktop app only" rather than as a dead dropdown.
  listDisplays: () => ipcRenderer.invoke('display:list'),
  // Subscribe to OS file-open events (double-clicked .tasmo / .gan). Returns a
  // disposer so the renderer can unsubscribe (StrictMode-safe).
  onOpenFile: (cb: (filePath: string) => void) => {
    const handler = (_e: unknown, filePath: string) => cb(filePath)
    ipcRenderer.on('open-file', handler)
    return () => ipcRenderer.removeListener('open-file', handler)
  },
  // In-place update of the packaged app (electron-updater, GitHub releases).
  // check() resolves {supported, version?, available?, reason?}; download()
  // streams progress through onProgress and resolves when the installer is
  // staged; install() kills the backend, quits and runs the installer.
  updater: {
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onProgress: (cb: (info: { percent: number; transferred: number; total: number }) => void) => {
      const handler = (_e: unknown, info: { percent: number; transferred: number; total: number }) => cb(info)
      ipcRenderer.on('updates:progress', handler)
      return () => ipcRenderer.removeListener('updates:progress', handler)
    },
  },
})
