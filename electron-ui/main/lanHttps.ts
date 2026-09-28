// The desktop shell's half of the LAN HTTPS listener (batch 11, H2).
//
// A browser exposes AudioContext.audioWorklet, the microphone, Web MIDI, the
// clipboard and crypto.subtle only in a SECURE CONTEXT -- https:// or
// localhost. A second computer opening theDAW at http://<lan-ip>:5173 is
// neither, so its EDIT tab dies on `ctx.audioWorklet` being undefined. Desktop
// mode therefore starts a second Vite listener in dev, the same app over TLS,
// beside electron-vite's own http one.
//
// WHETHER it starts is not decided here. `backend/lib/lan_https.py` owns that
// decision for both launchers (the setting, the LAN address, the certificate),
// and this side reads its answer from `python -m backend.lib.lan_https --json`
// rather than reimplementing it in TypeScript, where it would drift. What lives
// here is only the pure shape of that exchange: parsing the plan, composing the
// log line, and building the child's command and environment.
//
// No Electron import, so these run under plain node/tsx -- see
// ./lanHttps.test.ts, the same arrangement as ./downloadNaming.ts.

/** The plan `python -m backend.lib.lan_https --json` prints. */
export interface LanHttpsPlan {
  enabled: boolean
  /** The TLS port, whether or not the listener is enabled. */
  port: number
  /** `https://<lan-ip>:<port>`. Present exactly when enabled. */
  url: string | null
  /** PEM certificate path. Present exactly when enabled. */
  cert: string | null
  /** PEM key path. Present exactly when enabled. */
  key: string | null
  /** The vite executable to run. Present exactly when enabled. */
  vite: string | null
  /** Why it is off. Present only when it is. */
  reason: string | null
}

/** What the listener is started WITH, after the binary, from `frontend/`.
 *  Mirrors `LISTENER_ARGS` in backend/lib/lan_https.py. */
const LISTENER_ARGS = ['--config', 'vite.lan.config.ts']

/** The environment names `frontend/vite.lan.config.ts` reads. Renaming one of
 *  these breaks the listener silently, so they are stated once. */
export const LAN_HTTPS_CERT_ENV = 'theDAW_HTTPS_CERT'
export const LAN_HTTPS_KEY_ENV = 'theDAW_HTTPS_KEY'
export const LAN_HTTPS_PORT_ENV = 'theDAW_HTTPS_PORT'

const LAUNCH_TOKEN_ENV = 'THEDAW_LAUNCH_TOKEN'

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * The plan in a child's stdout, or null when there isn't a usable one.
 *
 * Read from the LAST line that parses, because Python's logging writes to
 * stderr but a wrapper (uv, a venv activation script, a warning filter) can
 * still put a line of its own on stdout ahead of ours.
 *
 * Null means "no plan": no listener, and the caller says so. An `enabled` plan
 * missing its url, certificate, key or vite binary is a broken contract, not a
 * usable plan, so it is null too -- starting vite without a certificate (or
 * starting nothing at all) would only produce a crash loop no one asked for.
 */
export function parseLanHttpsPlan(stdout: string): LanHttpsPlan | null {
  const lines = String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let raw: unknown
    try {
      raw = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const obj = raw as Record<string, unknown>
    if (typeof obj.enabled !== 'boolean') continue
    if (!Number.isInteger(obj.port)) continue
    const port = obj.port as number
    if (port <= 0 || port >= 65536) continue
    const plan: LanHttpsPlan = {
      enabled: obj.enabled,
      port,
      url: nonEmpty(obj.url),
      cert: nonEmpty(obj.cert),
      key: nonEmpty(obj.key),
      vite: nonEmpty(obj.vite),
      reason: nonEmpty(obj.reason),
    }
    if (plan.enabled && (!plan.url || !plan.cert || !plan.key || !plan.vite)) return null
    return plan
  }
  return null
}

/** The one line the desktop log carries about the LAN listener. Matches
 *  `LanHttpsPlan.log_line()` on the Python side so the two launchers read the
 *  same in a log. */
export function lanHttpsLogLine(plan: LanHttpsPlan | null): string {
  if (!plan) return 'LAN (https): off - no plan could be read'
  if (plan.enabled && plan.url) return `LAN (https): ${plan.url}`
  return `LAN (https): off - ${plan.reason ?? 'unavailable'}`
}

/**
 * How to start the listener on this platform, from `frontend/`.
 *
 * The binary is the frontend's own `node_modules/.bin/vite`, resolved by
 * backend/lib/lan_https.py and carried in the plan. It is NOT `npx`: on
 * Windows cmd searches the current directory before PATH, and a
 * non-interactive npx with no node_modules present downloads a copy of vite
 * from the registry in the middle of a launch.
 *
 * On Windows that binary is `vite.cmd`, a batch shim: node refuses to spawn
 * one directly (EINVAL, since the 2024 argument-injection fix), so it goes
 * through `cmd /c` -- the same reason spawnBackend's Windows fallback does.
 *
 * Each piece is its OWN argv element and NOTHING is pre-quoted here. The path
 * can contain a space (`C:\Program Files\...`), and quoting it ourselves broke
 * every such install: libuv builds cmd's command line from this array and
 * quotes any element containing a space itself, escaping the quotes already
 * inside it, so cmd was handed `\"C:\Program Files\...\vite.cmd\" --config ...`
 * and answered `'\"C:\Program Files\...\vite.cmd\"' is not recognized as an
 * internal or external command` (measured). Handing the path over unquoted,
 * libuv wraps it in the one pair of quotes cmd's two-quote rule strips, and the
 * batch shim runs with `--config vite.lan.config.ts` intact.
 */
export function lanListenerCommand(
  platform: string,
  plan: LanHttpsPlan,
): { command: string; args: string[] } {
  const vite = plan.vite
  if (!plan.enabled || !vite) {
    throw new Error('lanListenerCommand is for an enabled plan with a vite binary')
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', vite, ...LISTENER_ARGS] }
  }
  return { command: vite, args: [...LISTENER_ARGS] }
}

/**
 * The listener's environment: `base` plus the three names it reads.
 *
 * `ENABLE_HMR` is not one of them -- it is passed through from `base` like
 * everything else, exactly as `listener_env` does on the Python side. Setting
 * it starts a watcher over the whole repository, and the desktop shell has no
 * use for one.
 *
 * The launch token is dropped under every spelling (Windows environment names
 * ignore case) even though `buildBaseEnv` has already dropped it: vite here
 * runs the frontend's own devDependencies, and third-party code must never be
 * able to send `X-TheDAW-Launch-Token` and pass as the desktop shell. Defence
 * in depth costs one loop and survives a future caller passing a different
 * base.
 */
export function lanListenerEnv(
  base: NodeJS.ProcessEnv,
  plan: LanHttpsPlan,
): NodeJS.ProcessEnv {
  if (!plan.enabled || !plan.cert || !plan.key) {
    throw new Error('lanListenerEnv is for an enabled plan with a certificate')
  }
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === LAUNCH_TOKEN_ENV) delete env[key]
  }
  env[LAN_HTTPS_CERT_ENV] = plan.cert
  env[LAN_HTTPS_KEY_ENV] = plan.key
  env[LAN_HTTPS_PORT_ENV] = String(plan.port)
  return env
}

/**
 * The port the electron-vite renderer dev server actually got, read from the
 * ELECTRON_RENDERER_URL it hands the main process, or null outside dev (a
 * packaged build loads files and has no dev server). The server runs on 5173
 * with strictPort (electron.vite.config.ts), and the backend is told the port
 * it read here as theDAW_FRONTEND_PORT, so /api/network/lan reports the
 * address that is actually serving rather than one assumed from the config.
 */
export function rendererDevPort(url: string | undefined): number | null {
  if (!url) return null
  try {
    const port = Number(new URL(url).port)
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}
