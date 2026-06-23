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
    resolve: {
      alias: { '@': resolve(__dirname, '../frontend') }
    },
    server: {
      port: 5173,
      fs: {
        allow: [resolve(__dirname, '../frontend'), resolve(__dirname, '..')]
      },
      proxy: {
        '/api': {
          target: 'http://localhost:8600',
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0
        }
      }
    }
  }
})
