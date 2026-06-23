import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
} from 'electron'
import { ChildProcess, spawn, execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getRepoRoot(): string {
  if (app.isPackaged) {
    // In a packaged app, resources are at process.resourcesPath
    // The repo root concept doesn't apply the same way, but we keep
    // a reference for log directory placement next to the executable.
    return path.resolve(path.dirname(app.getPath('exe')))
  }
  // In dev: electron-vite transpiles to electron-ui/out/main/index.js
  // so __dirname = electron-ui/out/main. Three levels up = repo root.
  return path.resolve(__dirname, '..', '..', '..')
}

const repoRoot = getRepoRoot()

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logsDir = path.join(repoRoot, 'logs')
fs.mkdirSync(logsDir, { recursive: true })

const logStream = fs.createWriteStream(path.join(logsDir, 'backend.log'), {
  flags: 'a',
})

function log(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  logStream.write(line)
}

// ---------------------------------------------------------------------------
// Backend management
// ---------------------------------------------------------------------------

let backendProcess: ChildProcess | null = null
let weSpawnedBackend = false
let isQuitting = false

const BACKEND_BASE = 'http://localhost:8600'
const HEALTH_URL = `${BACKEND_BASE}/api/health`
const SHUTDOWN_URL = `${BACKEND_BASE}/api/admin/shutdown`

async function isBackendRunning(): Promise<boolean> {
  try {
    const res = await globalThis.fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

function spawnBackend(): void {
  log('Spawning backend process...')

  const isWindows = process.platform === 'win32'
  const cwd = repoRoot
  const env = { ...process.env, SA3_SUPERVISOR_PRESENT: '1' }

  if (isWindows) {
    backendProcess = spawn(
      'cmd',
      ['/c', 'uv run python -m backend._supervisor'],
      {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
  } else {
    backendProcess = spawn(
      'uv',
      ['run', 'python', '-m', 'backend._supervisor'],
      {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    )
  }

  weSpawnedBackend = true

  let stdoutCarry = ''
  backendProcess.stdout?.on('data', (data: Buffer) => {
    stdoutCarry += data.toString()
    const parts = stdoutCarry.split('\n')
    stdoutCarry = parts.pop()!
    for (const raw of parts) {
      const text = raw.replace(/\r$/, '')
      if (!text) continue
      log(`[backend:stdout] ${text}`)
      const cls = text.includes('[LOAD]') ? 'load' : ''
      sendLoadingLog(text, cls)
      if (text.includes('[LOAD]')) {
        sendLoadingStatus(text.replace(/.*\[LOAD\]\s*/, ''))
      }
    }
  })

  let stderrCarry = ''
  backendProcess.stderr?.on('data', (data: Buffer) => {
    stderrCarry += data.toString()
    const parts = stderrCarry.split('\n')
    stderrCarry = parts.pop()!
    for (const raw of parts) {
      const text = raw.replace(/\r$/, '')
      if (!text) continue
      log(`[backend:stderr] ${text}`)
      if (text.includes('WARNING') || text.includes('ERROR') || text.includes('Error')) {
        sendLoadingLog(text, 'err')
      } else {
        sendLoadingLog(text, '')
      }
    }
  })

  backendProcess.on('exit', (code, signal) => {
    const msg =
      `Backend process exited (code=${code}, signal=${signal}). ` +
      (weSpawnedBackend
        ? 'We spawned it — this may indicate a crash.'
        : 'External process.')
    log(msg)
    sendLoadingLog(msg, 'err')
    backendProcess = null
  })

  backendProcess.on('error', (err) => {
    log(`Backend process error: ${err.message}`)
    sendLoadingLog(`Backend process error: ${err.message}`, 'err')
    backendProcess = null
  })
}

// ---------------------------------------------------------------------------
// Kill backend on quit
// ---------------------------------------------------------------------------

function killBackend(): Promise<void> {
  return new Promise((resolve) => {
    if (!backendProcess || !weSpawnedBackend) {
      resolve()
      return
    }

    log('Killing backend process...')
    const proc = backendProcess
    const pid = proc.pid
    let settled = false

    const settle = (): void => {
      if (settled) return
      settled = true
      resolve()
    }

    proc.on('exit', () => {
      log('Backend process terminated.')
      settle()
    })

    // Step 1: attempt graceful HTTP shutdown
    globalThis
      .fetch(SHUTDOWN_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
      })
      .then(() => log('Sent shutdown request to backend.'))
      .catch(() => log('Shutdown endpoint unreachable — will force-kill.'))

    // Step 2: after a grace period, force-kill the process tree
    setTimeout(() => {
      if (settled) return
      if (!pid) {
        settle()
        return
      }
      log('Grace period expired — force-killing backend tree...')

      try {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/F', '/T', '/PID', String(pid)], (err) => {
            if (err) log(`taskkill error: ${err.message}`)
            else log('taskkill /T completed.')
            settle()
          })
        } else {
          // Kill the process group (negative PID) created by detached:true
          process.kill(-pid, 'SIGKILL')
          log('Sent SIGKILL to backend process group.')
          settle()
        }
      } catch {
        settle()
      }
    }, 3000)

    // Step 3: hard deadline so quit is never blocked forever
    setTimeout(() => {
      settle()
    }, 6000)
  })
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'theDAW',
    // Open full screen, per spec.
    fullscreen: true,
    // Paint solid black immediately so there's no white window flash before
    // content loads — one continuous black background from the first frame to
    // the app (matches index.html's <body> + the boot splash).
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      // The boot cinematic's logo is a muted, looping video — allow it to
      // autoplay without a user gesture (Chromium blocks this by default).
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // Load the React renderer IMMEDIATELY (no separate spinner page). The renderer
  // shows the boot cinematic and polls /api/health on its own, holding until the
  // backend is ready — exactly like the web app. This keeps ONE background the
  // whole time and keeps the desktop + web boot flows in sync.
  loadRenderer()
}

function loadRenderer(): void {
  if (!mainWindow) return
  const devURL = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devURL) {
    mainWindow.loadURL(devURL)
  } else if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadURL('app://./index.html')
  }
}

function escapeForJS(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

function sendLoadingLog(msg: string, cls?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const escaped = escapeForJS(msg)
  mainWindow.webContents.executeJavaScript(
    `if(typeof addLog==='function')addLog('${escaped}','${cls || ''}')`,
  ).catch(() => {})
}

function sendLoadingStatus(msg: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const escaped = escapeForJS(msg)
  mainWindow.webContents.executeJavaScript(
    `if(typeof setStatus==='function')setStatus('${escaped}')`,
  ).catch(() => {})
}

// ---------------------------------------------------------------------------
// Production: custom protocol for renderer files
// ---------------------------------------------------------------------------

function registerAppProtocol(): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url)

    // Intercept /api/* requests and proxy to backend
    if (url.pathname.startsWith('/api/')) {
      return net.fetch(`${BACKEND_BASE}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      })
    }

    // Serve static files from the built renderer output
    let filePath = url.pathname
    if (filePath === '/' || filePath === '') {
      filePath = '/index.html'
    }

    const rendererDir = path.join(__dirname, '../renderer')
    const fullPath = path.join(rendererDir, filePath)

    // Security: ensure the resolved path is within the renderer dir
    const resolved = path.resolve(fullPath)
    if (!resolved.startsWith(path.resolve(rendererDir))) {
      return new Response('Forbidden', { status: 403 })
    }

    return net.fetch(pathToFileURL(resolved).href)
  })
}

// ---------------------------------------------------------------------------
// IPC handlers for native dialogs
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  ipcMain.handle('dialog:selectFile', async () => {
    if (!mainWindow) return { canceled: true, filePaths: [] }
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
    })
    return result
  })

  ipcMain.handle('dialog:selectDirectory', async () => {
    if (!mainWindow) return { canceled: true, filePaths: [] }
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    })
    return result
  })

  ipcMain.handle(
    'dialog:showSave',
    async (_event, options: Electron.SaveDialogOptions) => {
      if (!mainWindow) return { canceled: true, filePath: undefined }
      const result = await dialog.showSaveDialog(mainWindow, options)
      return result
    },
  )

  // Quit the app on request (Settings "Shutdown" in desktop mode). app.quit()
  // triggers before-quit, which kills the spawned backend, then closes the window.
  ipcMain.handle('app:quit', () => {
    app.quit()
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Register custom protocol scheme before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

app.whenReady().then(async () => {
  registerIpcHandlers()

  // In production, register our custom protocol
  if (app.isPackaged) {
    registerAppProtocol()
  }

  // Window loads the renderer (boot cinematic) right away.
  createWindow()

  // Spawn the backend in the background if it isn't already up. The renderer's
  // own health polling + cinematic cover the wait; if the backend never comes
  // up, the app surfaces its "continue without backend" escape — same as web.
  const alreadyRunning = await isBackendRunning()
  if (!alreadyRunning) {
    spawnBackend()
  } else {
    log('Backend already running — skipping spawn.')
  }
})

app.on('window-all-closed', () => {
  // Quit on all platforms — theDAW is a DAW, not a utility app
  app.quit()
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  if (weSpawnedBackend && backendProcess) {
    isQuitting = true
    event.preventDefault()
    killBackend().finally(() => {
      app.quit()
    })
  }
})
