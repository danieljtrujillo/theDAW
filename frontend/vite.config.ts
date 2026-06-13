import {alphaTab} from '@coderline/alphatab-vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
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
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Modern output → less transpilation across the ~3.5k modules.
      target: 'es2022',
      rollupOptions: {
        output: {
          // Split the big, stable leaf vendors into their own long-cached
          // chunks so an app-code edit doesn't bust them, and the main chunk
          // shrinks. (three + react-force-graph are already code-split via
          // dynamic import in CymaticsVisualizer's lazy wrapper + LineageModal.)
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            wavesurfer: ['wavesurfer.js', '@wavesurfer/react'],
            icons: ['lucide-react'],
          },
        },
      },
    },
    server: {
      // Auto-reload is OFF BY DEFAULT so agent edits don't nuke app state.
      // To turn live reload back on: set ENABLE_HMR=true in the environment.
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://localhost:8600',
          changeOrigin: true,
          ws: true, // proxy WebSocket upgrades too (e.g. /api/questmidi/ws)
          timeout: 0,
          proxyTimeout: 0,
          configure: (proxy) => {
            proxy.on('error', (err, _req, res) => {
              // Return a proper JSON error instead of silently swallowing.
              // Without this, failed proxy requests hang indefinitely or
              // fall through to Vite's SPA handler producing misleading
              // "Not Found" or HTML responses instead of clear error JSON.
              if (res && !res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  detail: 'Backend unreachable — is the server running on port 8600?',
                }));
              }
            });
          },
        },
      },
      hmr: process.env.ENABLE_HMR === 'true',
      watch: process.env.ENABLE_HMR === 'true' ? undefined : null,
    },
  };
});
