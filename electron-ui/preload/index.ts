import { contextBridge, ipcRenderer } from 'electron'

// Where an open dialog starts, what it lists and its title. All optional.
interface OpenDialogOptions {
  defaultPath?: string
  filters?: Electron.FileFilter[]
  title?: string
}

// A finished, cancelled or interrupted download. path is where the file was
// written, and null for any state but 'completed'.
interface DownloadDone {
  path: string | null
  filename: string
  state: 'completed' | 'cancelled' | 'interrupted'
}

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  selectFile: (options?: OpenDialogOptions) => ipcRenderer.invoke('dialog:selectFile', options),
  selectDirectory: (options?: OpenDialogOptions) =>
    ipcRenderer.invoke('dialog:selectDirectory', options),
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
  // Subscribe to finished downloads (a save the renderer started). Returns a
  // disposer, same as onOpenFile.
  onDownloadDone: (cb: (info: DownloadDone) => void) => {
    const handler = (_e: unknown, info: DownloadDone) => cb(info)
    ipcRenderer.on('download-done', handler)
    return () => ipcRenderer.removeListener('download-done', handler)
  },
  // Item 4 (T17 audit): tell the main process these EXACT filenames are
  // about to be automatic downloads (generateStore's auto-download toggle,
  // one click per take), so watchDownloads saves a matching will-download
  // straight into the Downloads folder instead of opening the native Save
  // dialog. Call once, right before the click(s) it covers — a name it
  // never sees (an ordinary user download) keeps the dialog, and an
  // unclicked mark expires on its own after a few seconds.
  markAutomaticDownloads: (names: string[]) => ipcRenderer.invoke('downloads:markAutomatic', names),
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
