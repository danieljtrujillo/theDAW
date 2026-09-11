import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  session,
  shell,
} from 'electron'
import { ChildProcess, spawn, execFile } from 'child_process'
import { autoUpdater } from 'electron-updater'
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

// Guarded: on a read-only mount (AppImage squashfs, running a mac app straight
// off the dmg) an unguarded mkdirSync here killed the main process before any
// window existed. Fall back to Electron's per-user logs dir, then to a no-op
// stream so logging can never take the app down.
function openLogStream(): fs.WriteStream | null {
  for (const dir of [path.join(repoRoot, 'logs'), app.getPath('logs')]) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const stream = fs.createWriteStream(path.join(dir, 'backend.log'), {
        flags: 'a',
      })
      // Disk-full or revoked-handle write errors surface as an 'error' event;
      // without a listener that event crashes the process.
      stream.on('error', () => {})
      return stream
    } catch {
      // try the next location
    }
  }
  return null
}

const logStream = openLogStream()

function log(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  try {
    logStream?.write(line)
  } catch {
    // never let logging take the app down
  }
}

// ---------------------------------------------------------------------------
// Backend management
// ---------------------------------------------------------------------------

let backendProcess: ChildProcess | null = null
let weSpawnedBackend = false
let isQuitting = false
// First-run `uv sync` child; tracked so before-quit can kill it (an orphaned
// sync keeps downloading and holds the venv lock against the next launch).
let uvSyncProcess: ChildProcess | null = null

// 127.0.0.1, never 'localhost': the backend binds 0.0.0.0 (IPv4 only) and
// Chromium's resolver prefers ::1 for 'localhost' on Windows. When it does,
// every proxied /api/* call below fails to connect and the catch returns a
// synthetic 502 — which the renderer reported as "couldn't reach
// huggingface.co", sending users to debug their internet over a loopback
// mismatch. An address cannot resolve to the wrong family.
const BACKEND_BASE = 'http://127.0.0.1:8600'
const HEALTH_URL = `${BACKEND_BASE}/api/health`
const SHUTDOWN_URL = `${BACKEND_BASE}/api/admin/shutdown`

// ---------------------------------------------------------------------------
// Packaged-app paths + first-run bootstrap
//
// In a packaged build the Python project, a bundled uv.exe, and ffmpeg.exe ship
// under process.resourcesPath (see electron-builder.yml -> extraResources). The
// per-user install directory is writable, so uv creates the venv next to the
// bundled pyproject.toml on first launch and the backend writes its data/ tree
// there. In dev none of this applies: the backend runs from the repo via uv on
// PATH exactly as before.
// ---------------------------------------------------------------------------

function getPythonDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'python') : repoRoot
}

function getToolsDir(): string {
  return path.join(process.resourcesPath, 'tools')
}

function getUvCommand(): string {
  if (!app.isPackaged) return 'uv'
  // Packaged builds bundle the uv binary under resources/tools: 'uv.exe' on
  // Windows, 'uv' on macOS (see scripts/fetch-runtime-tools.mjs).
  return path.join(
    getToolsDir(),
    process.platform === 'win32' ? 'uv.exe' : 'uv',
  )
}

function venvPython(pyDir: string): string {
  return process.platform === 'win32'
    ? path.join(pyDir, '.venv', 'Scripts', 'python.exe')
    : path.join(pyDir, '.venv', 'bin', 'python')
}

// Environment for the backend + the uv sync step. Packaged builds prepend the
// bundled tools dir (uv.exe, ffmpeg.exe, ffprobe.exe) to PATH so the backend's
// audio I/O resolves ffmpeg without a system install. The PATH key is matched
// case-insensitively because Windows exposes it as "Path".
function buildBackendEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SA3_SUPERVISOR_PRESENT: '1' }
  if (app.isPackaged) {
    const toolsDir = getToolsDir()
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
    env[key] = `${toolsDir}${path.delimiter}${env[key] ?? ''}`
  }
  // Keep uv's package cache on the SAME volume as the venv (getPythonDir()) so
  // wheels hardlink into .venv on first-run sync instead of falling back to
  // slow full copies. uv cannot hardlink across volumes, and its default cache
  // lives on the system drive — which may differ from the drive the app is
  // installed on (or the repo lives on in dev). Same-volume cache = fast setup,
  // no "failed to hardlink" fallback, less disk. This also reaches any uv the
  // backend itself invokes (e.g. the on-demand Underfit trainer env). An
  // explicit UV_CACHE_DIR (e.g. from theDAW.bat's dev/web launch) is respected.
  const cacheKey = Object.keys(env).find((k) => k.toLowerCase() === 'uv_cache_dir')
  if (!cacheKey) env.UV_CACHE_DIR = path.join(getPythonDir(), '.uv-cache')
  return env
}

function coreImportsOk(py: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(py, ['-c', 'import uvicorn, fastapi'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      proc.on('exit', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

function runUvSync(uvCmd: string, cwd: string): Promise<void> {
  return new Promise((resolve) => {
    log(`Running ${uvCmd} sync --group dev in ${cwd}`)
    const proc = spawn(uvCmd, ['sync', '--group', 'dev'], {
      cwd,
      env: buildBackendEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // Track the child so quitting mid-setup kills it instead of orphaning a
    // multi-GB download that holds the venv lock against the next launch.
    uvSyncProcess = proc
    const emit = (data: Buffer): void => {
      for (const raw of data.toString().split('\n')) {
        const text = raw.replace(/\r$/, '').trimEnd()
        if (!text.trim()) continue
        log(`[uv] ${text}`)
        sendLoadingLog(text, '')
      }
    }
    proc.stdout?.on('data', emit)
    proc.stderr?.on('data', emit)
    proc.on('exit', (code) => {
      uvSyncProcess = null
      if (code === 0) {
        sendLoadingLog('Dependencies installed.', 'load')
      } else {
        sendLoadingStatus('Setup failed — see the error below')
        sendLoadingLog(
          `Setup step exited with code ${code}. The app may not start until this is resolved.`,
          'err',
        )
      }
      resolve()
    })
    proc.on('error', (err) => {
      uvSyncProcess = null
      sendLoadingStatus('Setup failed — see the error below')
      sendLoadingLog(`Setup failed to start: ${err.message}`, 'err')
      resolve()
    })
  })
}

// First-run bootstrap: build the venv when it is missing or a core import fails
// (a uv sync interrupted after the venv is created but before packages install
// leaves a half-built env). Streams progress into the boot cinematic. No-op in
// dev, where the repo venv is managed by theDAW.bat / uv on PATH.
async function ensurePythonEnv(): Promise<void> {
  if (!app.isPackaged) return
  const pyDir = getPythonDir()
  const py = venvPython(pyDir)
  let ok = fs.existsSync(py)
  if (ok) ok = await coreImportsOk(py)
  if (ok) {
    log('Python env present and complete — skipping sync.')
    return
  }
  sendLoadingStatus('First run: setting up the audio engine')
  sendLoadingLog(
    'Installing the Python runtime and dependencies. The first run downloads several GB and can take several minutes.',
    'load',
  )
  await runUvSync(getUvCommand(), pyDir)
}

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
  const cwd = getPythonDir()
  const env = buildBackendEnv()
  const devVenvPy = venvPython(cwd)
  const useDevVenv = !app.isPackaged && fs.existsSync(devVenvPy)

  if (app.isPackaged) {
    // The bundled uv is an absolute path, so it is invoked directly (no shell).
    backendProcess = spawn(
      getUvCommand(),
      ['run', 'python', '-m', 'backend._supervisor'],
      {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWindows,
      },
    )
  } else if (useDevVenv) {
    // Dev: launch with the project venv's Python directly. `uv run` can fail when
    // uv's cache is unavailable, which silently leaves no backend on :8600 — the
    // frontend then shows 500s for every /api call (Vite's proxy returns 500 on
    // ECONNREFUSED). theDAW.bat already provisions the venv, so this is the
    // reliable dev path; the uv branches below remain the fallback.
    log(`Spawning backend via venv Python: ${devVenvPy}`)
    backendProcess = spawn(
      devVenvPy,
      ['-m', 'backend._supervisor'],
      {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: isWindows,
        detached: !isWindows,
      },
    )
  } else if (isWindows) {
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

// ---------------------------------------------------------------------------
// OS file-open (.tasmo / .gan associations)
//
// Double-clicking an associated file launches (or re-uses) theDAW with the path
// in argv (Windows/Linux) or via the 'open-file' event (macOS). We forward the
// path to the renderer, which routes .tasmo -> project load and .gan -> the MIX
// plugin loader. If the window isn't ready yet, the path is held and flushed on
// did-finish-load.
// ---------------------------------------------------------------------------

let pendingOpenFile: string | null = null

function fileArgFrom(argv: string[]): string | null {
  for (const a of argv) {
    if (typeof a !== 'string') continue
    const lower = a.toLowerCase()
    if ((lower.endsWith('.tasmo') || lower.endsWith('.gan')) && fs.existsSync(a)) {
      return a
    }
  }
  return null
}

function deliverOpenFile(filePath: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-file', filePath)
  } else {
    pendingOpenFile = filePath
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'theDAW',
    // Open windowed at the default size (reverted from forced fullscreen).
    fullscreen: false,
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

  // Route outbound http(s) links (update/release pages, the Hugging Face
  // sign-in) to the user's default browser, where they may already be signed
  // in. Same-origin http(s) — the dev server's own navigations — stays in-app,
  // and so does the local backend origin (the packaged renderer opens the VJ
  // pop-out at BACKEND_BASE/vj-app, which must be an in-app child window so
  // the renderer keeps a window handle for postMessage control).
  const isExternal = (url: string): boolean => {
    if (!/^https?:\/\//i.test(url)) return false
    try {
      const target = new URL(url)
      if (target.origin === new URL(BACKEND_BASE).origin) return false
      const here = mainWindow?.webContents.getURL() || 'app://./'
      return target.origin !== new URL(here).origin
    } catch {
      return false
    }
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isExternal(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // Load the React renderer IMMEDIATELY (no separate spinner page). The renderer
  // shows the boot cinematic and polls /api/health on its own, holding until the
  // backend is ready — exactly like the web app. This keeps ONE background the
  // whole time and keeps the desktop + web boot flows in sync.
  loadRenderer()
}

function loadRenderer(): void {
  if (!mainWindow) return
  // Flush any file the app was opened with once the renderer has loaded.
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpenFile && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('open-file', pendingOpenFile)
      pendingOpenFile = null
    }
  })
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

    // Intercept /api/* requests and proxy to backend. duplex:'half' is
    // REQUIRED whenever body is a stream — without it the fetch-spec Request
    // constructor throws and every body-carrying POST/PUT in the packaged app
    // fails with net::ERR_FAILED. The catch turns backend-down into a clean
    // 502 instead of an opaque network error.
    if (url.pathname.startsWith('/api/')) {
      return net
        .fetch(`${BACKEND_BASE}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          duplex: 'half',
        } as RequestInit)
        .catch((err) => {
          // The reason travels with the status. A bare 502 here was read as
          // "huggingface.co is down" for two days; the header says which hop
          // actually failed, and the body says why.
          const why = err instanceof Error ? err.message : String(err)
          log(`API proxy failed: ${request.method} ${url.pathname} -> ${why}`)
          return new Response(`theDAW backend unreachable at ${BACKEND_BASE}: ${why}`, {
            status: 502,
            headers: { 'x-thedaw-proxy-error': 'backend-unreachable' },
          })
        })
    }

    // Proxy the backend-served static VJ build too, so any relative /vj-app/
    // URL works under the app:// origin (the renderer bundle contains no
    // vj-app; the build ships beside the backend and is mounted by server.py).
    if (url.pathname === '/vj-app' || url.pathname.startsWith('/vj-app/')) {
      return net
        .fetch(`${BACKEND_BASE}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
        })
        .catch(() => new Response('backend unavailable', { status: 502 }))
    }

    // Same for the SwayCommand cockpit embed. Exact-match-or-slash-prefix, not
    // a bare startsWith('/sway-app'), which would also swallow paths like
    // /sway-application.
    if (url.pathname === '/sway-app' || url.pathname.startsWith('/sway-app/')) {
      return net
        .fetch(`${BACKEND_BASE}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
        })
        .catch(() => new Response('backend unavailable', { status: 502 }))
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

  // Native window handle (HWND on Windows) for embedding a VST3 editor window
  // into the MIX area: the backend sidecar reparents the editor under this HWND.
  // getNativeWindowHandle() returns a Buffer holding the pointer; encode it as a
  // decimal string so it survives JSON/IPC without precision loss.
  ipcMain.handle('window:getNativeHandle', () => {
    if (!mainWindow) return null
    try {
      const buf = mainWindow.getNativeWindowHandle()
      const value = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
      return value.toString()
    } catch {
      return null
    }
  })

  // Screen-space rect of the web content area (DIP), so the renderer can convert
  // an element's client rect into absolute screen pixels for positioning the
  // embedded VST window. Changes as the window moves/resizes.
  ipcMain.handle('window:getContentBounds', () => {
    if (!mainWindow) return null
    try {
      return mainWindow.getContentBounds()
    } catch {
      return null
    }
  })

  registerUpdaterHandlers()
}

// ---------------------------------------------------------------------------
// In-place updates for the packaged app (electron-updater over GitHub releases)
// ---------------------------------------------------------------------------
//
// Windows only in practice: the NSIS installer updates unsigned. The macOS
// dmg is unsigned, and Squirrel.Mac refuses to install an unsigned update, so
// check() reports unsupported there and the renderer opens the dmg download
// instead. In dev (not packaged) there is no app-update.yml, so the renderer
// falls back to the backend's git-pull path.

function updaterSupport(): { supported: boolean; reason?: string } {
  if (!app.isPackaged) return { supported: false, reason: 'dev' }
  if (process.platform === 'darwin') return { supported: false, reason: 'unsigned-mac' }
  return { supported: true }
}

let updateDownloaded = false

function registerUpdaterHandlers(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {
    info: (m: unknown) => log(`[updater] ${String(m)}`),
    warn: (m: unknown) => log(`[updater] warn: ${String(m)}`),
    error: (m: unknown) => log(`[updater] error: ${String(m)}`),
    debug: () => {},
  }
  autoUpdater.on('download-progress', (p) => {
    mainWindow?.webContents.send('updates:progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
    })
  })
  autoUpdater.on('update-downloaded', () => {
    updateDownloaded = true
  })

  ipcMain.handle('updates:check', async () => {
    const support = updaterSupport()
    if (!support.supported) return support
    try {
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo?.version ?? null
      const available = version !== null && version !== app.getVersion()
      return { supported: true, version, available, current: app.getVersion() }
    } catch (err) {
      return { supported: true, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('updates:download', async () => {
    const support = updaterSupport()
    if (!support.supported) return support
    try {
      updateDownloaded = false
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('updates:install', async () => {
    if (!updateDownloaded) return { ok: false, error: 'No update has been downloaded yet.' }
    // The installer overwrites resources/python, so the backend (and the venv
    // interpreters under it) must be gone first. before-quit would do this
    // too, but the installer is already launching by then.
    isQuitting = true
    await killBackend()
    // isSilent=false shows the NSIS UI; isForceRunAfter=true relaunches theDAW.
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Windows camera backend: Chromium defaults to the Media Foundation video-capture
// backend, which does NOT enumerate many virtual / phone-as-webcam bridges
// (Iriun, Camo, DroidCam, EpocCam, NDI, OBS virtual camera) that register only as
// DirectShow devices — so they never appear in enumerateDevices() and can't be
// picked in the camera selector. Forcing the DirectShow capturer surfaces them.
// Physical cameras keep working under DirectShow on Windows 10/11; remove this
// switch only if a specific Media-Foundation-only device regresses.
//
// IsolateSandboxedIframes: Chromium moves every sandboxed srcdoc frame (the
// Foundry's 24 custom-code pads, `sandbox="allow-scripts"`) into a renderer
// process of its own. In this app that process grows about 250 MB a second
// whether or not the pads' scripts run, is killed near 2.4 GB about ten
// seconds after the frames load, and Chromium paints the dead frames grey.
// Measured 2026-09-10 on Electron 42.11 / Chromium 148; browser tabs and
// headless runs never isolate these frames, so it only showed in the desktop
// app. With the feature off the frames stay sandboxed (opaque origin, no
// same-origin access) inside the Foundry's own renderer, all of them stay
// alive, and memory stays flat. Re-check on every Electron upgrade: the leak
// is Chromium's and may be fixed upstream.
const disabledFeatures = ['IsolateSandboxedIframes']
if (process.platform === 'win32') disabledFeatures.push('MediaFoundationVideoCapture')
app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','))

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

// Single-instance: a second launch (e.g. double-clicking a .tasmo while running)
// forwards its file arg to the existing window instead of starting a second app.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}
app.on('second-instance', (_event, argv) => {
  const f = fileArgFrom(argv)
  if (f) deliverOpenFile(f)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})
// macOS delivers associated files via this event rather than argv.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  deliverOpenFile(filePath)
})

if (gotSingleInstanceLock) app.whenReady().then(async () => {
  // The path the app was launched with (Windows/Linux argv), flushed to the
  // renderer once it loads.
  const launchFile = fileArgFrom(process.argv)
  if (launchFile) pendingOpenFile = launchFile


  // Identify as theDAW, not "Electron": names the process / menu / userData dir
  // and, via the AppUserModelID, the Windows taskbar grouping + shortcut binding.
  app.setName('theDAW')
  app.setAppUserModelId('com.gantasmo.thedaw')

  // Grant media (microphone / camera) capture to the renderer. Electron layers
  // its own permission gate on top of the OS; with no handler a getUserMedia
  // track can return MUTED — the OS opens the device but the renderer receives
  // silence. The renderer only ever loads our own local content, so granting is
  // safe. Mic capture (vocal record) and camera (VJ) both depend on this.
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(true))
  ses.setPermissionCheckHandler(() => true)

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
    // Packaged builds bootstrap the Python env on first launch before the
    // backend can start; dev builds no-op here.
    await ensurePythonEnv()
    // The await above can resume AFTER the user began quitting mid-setup;
    // spawning then would launch a backend nothing ever kills.
    if (!isQuitting) spawnBackend()
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
  isQuitting = true
  // Kill an in-flight first-run sync so it doesn't outlive the app holding
  // the venv lock (on Windows the child survives parent death otherwise).
  if (uvSyncProcess && uvSyncProcess.exitCode === null) {
    try {
      uvSyncProcess.kill()
    } catch {
      // already gone
    }
  }
  if (weSpawnedBackend && backendProcess) {
    event.preventDefault()
    killBackend().finally(() => {
      app.quit()
    })
  }
})
