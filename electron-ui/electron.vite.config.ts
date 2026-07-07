import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, '../frontend'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(__dirname, '../frontend/index.html') }
      }
    },
    plugins: [react(), tailwindcss()],
    // alphaTab resolves its Bravura font + worker via import.meta.url relative
    // to its own dist/. Vite's dep pre-bundling rewrites that into .vite/deps/
    // where the worker does NOT exist, which wedges the renderer ("alphaTab.
    // worker.mjs does not exist in the optimize deps directory"). Excluding it
    // (matching frontend/vite.config.ts) keeps it served from node_modules so
    // the worker + font URLs stay valid. Without this, desktop mode hangs on
    // "loading" and scores never render.
    optimizeDeps: {
      exclude: ['@coderline/alphatab'],
    },
    resolve: {
      alias: { '@': resolve(__dirname, '../frontend') }
    },
    server: {
      port: 5173,
      // Bind ALL interfaces (not loopback) so a phone on the LAN can reach the
      // companion (mobile.html + the /api control-bus proxy) while the DESKTOP
      // app is the host. electron-vite/Vite default to localhost-only, which is
      // why the phone got connection-refused whenever the desktop app was open.
      // Never leave this loopback-only.
      host: '0.0.0.0',
      fs: {
        allow: [resolve(__dirname, '../frontend'), resolve(__dirname, '..')]
      },
      proxy: {
        '/api': {
          target: 'http://localhost:8600',
          changeOrigin: true,
          // WebSocket upgrade (xr control bus, questmidi) — without this the
          // proxy silently drops WS connections and the control manifest
          // never reaches consumers (VST-Foundry bindings, XR headset).
          ws: true,
          timeout: 0,
          proxyTimeout: 0
        },
        // Static VJ build served by the backend (matches frontend/vite.config.ts).
        // Without this the VJ iframe's /vj-app/ request fell through to Vite's
        // SPA fallback, which served the app's own index.html INTO the iframe —
        // the whole app nested inside itself (doubled header) in electron dev.
        '/vj-app': {
          target: 'http://localhost:8600',
          changeOrigin: true,
          ws: true,
          timeout: 0,
          proxyTimeout: 0
        }
      }
    }
  }
})
