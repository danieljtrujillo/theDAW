import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

// Standalone build of the Underfit assistant orb. Bundles React + the orb +
// its CSS into a single self-contained JS/CSS pair emitted straight into
// underfit's dashboard (served on :8791). Kept in a SEPARATE config so theDAW's
// normal `npm run build` (vite.config.ts) is completely untouched.
//   Build with:  npm run build:orb
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {'process.env.NODE_ENV': JSON.stringify('production')},
  build: {
    target: 'es2022',
    // underfit lives beside StableDAW: <projects>/underfit/dashboard/assistant
    outDir: path.resolve(__dirname, '../../underfit/dashboard/assistant'),
    // MUST stay false: dashboard/assistant/ also holds underfit's own assets
    // (fonts, worklets, logos). Emptying it would delete them.
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, 'src/orb-standalone/main.tsx'),
      name: 'UnderfitOrb',
      formats: ['iife'],
      fileName: () => 'underfit-orb.js',
    },
    rollupOptions: {
      output: {assetFileNames: 'underfit-orb.[ext]'},
    },
  },
});
