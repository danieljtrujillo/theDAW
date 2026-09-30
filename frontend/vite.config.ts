import {alphaTab} from '@coderline/alphatab-vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {createLogger, defineConfig, loadEnv} from 'vite';
import {buildInfoDefines} from './buildInfo.config.ts';
import {plainAscii} from './src/lib/plainText.ts';

// During startup the frontend comes up before the backend binds :8600, so every
// proxied /api request (health, modules, library, assistant, …) fails with
// ECONNREFUSED until it does. Vite logs each one ("[vite] http proxy error: …"),
// which floods the console for 20-30s and looks like a crash. Those are benign
// retries — the app's own loading screen reflects real readiness — so this
// logger drops just that proxy-error noise and passes every other log through.
//
// The same logger also takes the emoji out of every line Vite writes. Vite
// announces optimized dependencies with a sparkle, and a pictograph in a
// diagnostic stream carries no information: the console is read to find out
// what broke. It is also a hazard on Windows, where a console on a legacy code
// page raises UnicodeEncodeError on an astral-plane character and can take the
// operation down with it (see backend/modules/midi/engine.py, which already
// works around exactly that for basic-pitch). Musical symbols and the dingbats
// Every glyph is folded to the ASCII that means the same thing; see lib/plainText.
const quietLogger = createLogger();
const baseError = quietLogger.error.bind(quietLogger);
const baseWarn = quietLogger.warn.bind(quietLogger);
const baseInfo = quietLogger.info.bind(quietLogger);
const clean = (msg: string): string => (typeof msg === 'string' ? plainAscii(msg) : msg);
quietLogger.error = (msg, options) => {
  const s = typeof msg === 'string' ? msg : '';
  if (s.includes('proxy error') || s.includes('ECONNREFUSED')) return;
  baseError(clean(msg), options);
};
quietLogger.warn = (msg, options) => baseWarn(clean(msg), options);
quietLogger.info = (msg, options) => baseInfo(clean(msg), options);

// ---------------------------------------------------------------------------
// Cross-origin isolation — OPT-IN, off by default.
//
// COOP: same-origin + COEP: require-corp are what make `crossOriginIsolated`
// true, and that flag is the only thing that lets SharedArrayBuffer be
// constructed — the ring buffer a live plugin host (#29) and disk streaming
// (#66) both need to hand an AudioWorklet. They cannot be added by the page
// after the fact, so they have to come from the server.
//
// They are NOT on by default, and that is deliberate. COEP makes the browser
// reject any embedded document that does not carry an embedder policy of its
// own, and three tabs people open every day embed sidecars on their own
// origins — Underfit (:8791), VST Foundry (:5472), the Lyria sidecar — none of
// which sends one. The companion QR code is a cross-origin <img> from
// api.qrserver.com (components/layout/Shell.tsx) and goes the same way. COOP
// additionally severs the window handle behind the VJ pop-out in the packaged
// app, where the pop-out is loaded from the backend's http origin rather than
// app://. Until those are proxied same-origin (T29B), turning isolation on by
// default would trade working tabs for a capability nothing ships yet.
//
// And it would cost that on the LAN for nothing: a phone reaching this dev
// server at http://<LAN-IP>:5173 is not a secure context, so the browser
// withholds isolation there however correct the headers are — COEP is still
// ENFORCED (embeds break) while crossOriginIsolated stays false (no payoff).
//
// So: set `theDAW_ISOLATE=1` in the environment to turn it on. Unset, every
// response is byte-identical to what it was before this block existed.
// electron-ui/main/index.ts reads the SAME variable for packaged builds, and
// frontend/src/lib/sabSupport.ts is what reads the result at runtime.
export const ISOLATION_ENABLED = process.env.theDAW_ISOLATE === '1';

/**
 * The document headers isolation needs, or nothing at all.
 *
 * Split out as a pure function of the flag so the decision can be read (and
 * tested) without booting a dev server: `enabled` false must yield an EMPTY
 * map, not a map of empty strings, because Vite spreads this into
 * `server.headers` and a present-but-empty header still goes on the wire.
 */
export function isolationHeaders(enabled: boolean): Record<string, string> {
  if (!enabled) return {};
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
}

// The VJ and SwayCommand builds are backend-served DOCUMENTS this app puts in
// an iframe. A cross-origin-isolated page will not embed a child document that
// does not itself carry an embedder policy — same origin or not, an iframe is
// checked against the embedder's COEP, so without this the two tabs would go
// blank with ERR_BLOCKED_BY_RESPONSE the moment isolation was turned on. The
// backend is out of this ticket's write set, so the dev proxy stamps both
// headers on the way through; a packaged build gets them from the matching
// branches of the app:// handler in electron-ui/main/index.ts.
// COOP rides along for the same reason in reverse: the VJ tab can be POPPED
// OUT into its own window and is then driven by postMessage through the handle
// window.open() returned. A COOP: same-origin opener that opens a document
// without COOP: same-origin is put in a different browsing context group and
// that handle is severed — the pop-out would open and then ignore every
// command. Same origin is not enough; the policy has to match.
const embedHeaders = (proxyRes: {headers: Record<string, string | string[] | undefined>}): void => {
  proxyRes.headers['cross-origin-opener-policy'] = 'same-origin';
  proxyRes.headers['cross-origin-embedder-policy'] = 'require-corp';
  proxyRes.headers['cross-origin-resource-policy'] = 'same-origin';
};

// A module-id test for one or more npm packages: true when the module sits in
// that package's directory under node_modules, on POSIX and Windows paths alike.
const vendorTest = (...pkgs: string[]) => {
  const dirs = pkgs.map((p) => `/node_modules/${p}/`);
  return (id: string): boolean => {
    const posix = id.replaceAll('\\', '/');
    return dirs.some((d) => posix.includes(d));
  };
};

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    customLogger: quietLogger,
    // alphaTab() copies the Bravura font + worker/worklet assets and wires
    // their URLs through Vite, so the Score-tab tab viewer needs no manual
    // font configuration. It returns an array of plugins; Vite flattens it.
    plugins: [react(), tailwindcss(), alphaTab()],
    optimizeDeps: {
      // alphaTab resolves its Bravura font and workers via import.meta.url
      // relative to its own dist/. Vite's dep pre-bundling rewrites that to
      // .vite/deps/, where the font does not exist (it 404s to index.html and
      // alphaTab reports "Font Loading Failed"), and the alphaTab() source
      // transform can't reach a pre-bundled copy. Excluding it keeps the
      // font/worker URLs correct in dev.
      exclude: ['@coderline/alphatab'],
    },
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      // __APP_BUILD_SHA__ / __APP_BUILD_TIME__ — shown in the Update dialog.
      ...buildInfoDefines(import.meta.dirname),
    },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    // Web workers are emitted as ES MODULES, not the iife Vite defaults to.
    // `components/audio/djSemanticWaveform.worker.ts` is constructed with
    // `new Worker(new URL(...), { type: 'module' })`, and a module worker
    // handed an iife bundle is a mismatch that only shows up in a production
    // build — in dev Vite serves the worker as a module regardless, so the
    // waveform analysis works locally and silently falls back to the
    // synchronous main-thread path (the very burst DJ-2 removed) in the
    // packaged app. It also lets the worker share the code-split chunks
    // rather than inlining a second copy of the analysis module.
    worker: {
      format: 'es',
    },
    build: {
      // Modern output → less transpilation across the ~3.5k modules.
      target: 'es2022',
      rolldownOptions: {
        // Two entries: the desktop app (index.html) and the phone companion
        // (mobile.html -> src/mobile/main.tsx). The mobile tree never imports
        // three/alphaTab/force-graph, so its chunk stays small; the phone never
        // downloads the desktop bundle.
        input: {
          main: path.resolve(import.meta.dirname, 'index.html'),
          mobile: path.resolve(import.meta.dirname, 'mobile.html'),
        },
        output: {
          // Split the big, stable leaf vendors into their own long-cached
          // chunks so an app-code edit doesn't bust them, and the main chunk
          // shrinks. `three` is loaded both eagerly (the boot cinematic,
          // LiquidChromeTitle) and lazily (the visualizer), so giving it a
          // dedicated chunk keeps exactly one cached copy and pulls ~600KB out of
          // the entry chunk. (react-force-graph stays code-split via LineageModal.)
          // Vite 8 bundles with Rolldown, which takes named groups matched by
          // module path (Rollup's object-form manualChunks is not accepted).
          codeSplitting: {
            groups: [
              {name: 'react-vendor', test: vendorTest('react', 'react-dom')},
              {name: 'three', test: vendorTest('three')},
              {name: 'wavesurfer', test: vendorTest('wavesurfer.js', '@wavesurfer/react')},
              {name: 'icons', test: vendorTest('lucide-react')},
              // Heavy leaf libs pulled in by specific features; give them their own
              // long-cached chunks so they leave the main entry chunk (and an app
              // edit never busts them). Behaviour is unchanged — pure bundling.
              {name: 'genai', test: vendorTest('@google/genai')},
              {name: 'markdown', test: vendorTest('react-markdown', 'remark-gfm', 'marked')},
              {name: 'spessasynth', test: vendorTest('spessasynth_core', 'spessasynth_lib')},
              {name: 'maplibre', test: vendorTest('maplibre-gl')},
            ],
          },
        },
      },
    },
    server: {
      // Bind ALL interfaces so the phone companion is LAN-reachable even if the
      // dev server is launched without the --host flag. Must never be
      // loopback-only. (The npm "dev" script also passes --host=0.0.0.0.)
      host: '0.0.0.0',
      // Auto-reload is OFF BY DEFAULT so agent edits don't nuke app state.
      // To turn live reload back on: set ENABLE_HMR=true in the environment.
      port: 5173,
      strictPort: true,
      // Empty unless theDAW_ISOLATE=1 — see ISOLATION_ENABLED above. Vite sends
      // no header for an empty map, so the default path is exactly what it was.
      headers: isolationHeaders(ISOLATION_ENABLED),
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8600',
          changeOrigin: true,
          ws: true, // proxy WebSocket upgrades too (e.g. /api/questmidi/ws)
          timeout: 0,
          proxyTimeout: 0,
          // Stamps X-Forwarded-For/-Proto/-Port so the backend can recover the
          // real caller's address (this proxy always connects to it from
          // loopback itself, dev server bound on 0.0.0.0 or not). Without this
          // every LAN caller — e.g. a phone on the network — reaches a
          // loopback-gated route (POST /api/vst/live/session, LAN2) looking
          // like this machine. uvicorn's ProxyHeadersMiddleware reads this
          // header and rewrites request.client to the real caller.
          // proxy_headers defaults to True; backend/run.py pins
          // forwarded_allow_ips="127.0.0.1" (this proxy's own peer address)
          // explicitly (T02), rather than leaning on that argument's own
          // default, which reads the FORWARDED_ALLOW_IPS environment
          // variable (falling back to the literal "127.0.0.1" only when it
          // is unset) and so could be widened by whatever sets that variable
          // on the machine.
          xfwd: true,
          configure: (proxy) => {
            // Under require-corp the browser demands a Cross-Origin-Resource-
            // Policy on anything the document pulls in. The backend does not
            // send one (it is out of this ticket's reach), so the proxy stamps
            // it on the way through. same-origin is correct because these
            // responses reach the page as http://<dev-host>:<port>/api/… —
            // the page's own origin. A packaged build needs the same header on
            // the app:// handler's /api branch; see electron-ui/main/index.ts.
            // Not registered at all when isolation is off: no listener, no
            // header, nothing between the backend and the page that was not
            // there before.
            if (ISOLATION_ENABLED) {
              proxy.on('proxyRes', (proxyRes) => {
                proxyRes.headers['cross-origin-resource-policy'] = 'same-origin';
              });
            }
            proxy.on('error', (_err, _req, res) => {
              // For HTTP errors res is ServerResponse; for WebSocket errors it
              // is a net.Socket (no writeHead). Guard before writing headers.
              // Double cast: Socket and ServerResponse share no index
              // signature, so TS rejects the direct assertion. This line was
              // never type-checked before — vite.config.ts only entered the
              // program when src/lib/isolationHeaders.test.ts imported it.
              const r = res as unknown as Record<string, unknown>;
              if (typeof r['writeHead'] === 'function' && !r['headersSent']) {
                (r['writeHead'] as (s: number, h: Record<string, string>) => void)(
                  502, { 'Content-Type': 'application/json' }
                );
                (r['end'] as (b: string) => void)(JSON.stringify({
                  detail: 'Backend unreachable — is the server running on port 8600?',
                }));
              }
            });
          },
        },
        // The VJ tab embeds the backend-served static VJ build (vite base
        // '/vj-app/'). Proxy it to the backend so the iframe loads it
        // same-origin in dev, exactly as it already is in packaged/Docker.
        '/vj-app': {
          target: 'http://127.0.0.1:8600',
          changeOrigin: true,
          // A no-op when isolation is off: the listener is never attached,
          // so the proxied response reaches the page exactly as the backend
          // sent it.
          configure: (proxy) => {
            if (ISOLATION_ENABLED) proxy.on('proxyRes', embedHeaders);
          },
        },
        // SwayCommand cockpit embed build. Same-origin in dev is REQUIRED, not
        // cosmetic: Chromium gives a cross-origin hidden iframe zero rAF
        // callbacks and SwayCommand's transport clock runs on rAF.
        '/sway-app': {
          target: 'http://127.0.0.1:8600',
          changeOrigin: true,
          // A no-op when isolation is off: the listener is never attached,
          // so the proxied response reaches the page exactly as the backend
          // sent it.
          configure: (proxy) => {
            if (ISOLATION_ENABLED) proxy.on('proxyRes', embedHeaders);
          },
        },
      },
      hmr: process.env.ENABLE_HMR === 'true',
      watch: process.env.ENABLE_HMR === 'true' ? undefined : null,
    },
  };
});
