import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    // onnxruntime-web ships its own wasm loader (.mjs + .wasm); esbuild's
    // dep pre-bundling mangles the runtime path resolution, so exclude it and
    // let Vite serve the package as-is. The .jsep.wasm binary is pulled in via
    // an explicit `?url` import in src/lib/inpaint/lamaOnnx.ts.
    optimizeDeps: {
      exclude: ['onnxruntime-web'],
    },
    server: {
      // HMR is disabled via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
