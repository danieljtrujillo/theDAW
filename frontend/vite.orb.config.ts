import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {fileURLToPath} from 'url';
import {defineConfig} from 'vite';

// This folder, from import.meta.url: __dirname exists only under Vite's
// default bundle loader, and `--configLoader runner` (which writes no temp
// file into node_modules) evaluates the config as a real ES module.
const here = path.dirname(fileURLToPath(import.meta.url));

// Standalone build of the Underfit assistant orb. Bundles React + the orb +
// its CSS into a single self-contained JS/CSS pair emitted straight into
// underfit's dashboard (served on :8791). Kept in a SEPARATE config so theDAW's
// normal `npm run build` (vite.config.ts) is completely untouched.
//   Build with:  npm run build:orb
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {'process.env.NODE_ENV': JSON.stringify('production')},
  // The bundle references none of public/, and copying all of it (splash,
  // worklets, soundfonts) into the dashboard folder on every build left stale
  // duplicates of theDAW's assets inside the underfit subrepo.
  publicDir: false,
  build: {
    target: 'es2022',
    // underfit is vendored inside this repo (git-subrepo at <repo>/underfit),
    // so the bundle goes to <repo>/underfit/dashboard/assistant. It used to
    // point one level higher, at a sibling checkout that no longer exists.
    outDir: path.resolve(here, '../underfit/dashboard/assistant'),
    // MUST stay false: dashboard/assistant/ also holds underfit's own assets
    // (fonts, worklets, logos). Emptying it would delete them.
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(here, 'src/orb-standalone/main.tsx'),
      name: 'UnderfitOrb',
      formats: ['iife'],
      fileName: () => 'underfit-orb.js',
    },
    rolldownOptions: {
      output: {assetFileNames: 'underfit-orb.[ext]'},
    },
  },
});
