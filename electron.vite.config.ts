import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Dependencies of main/preload stay external (electron-vite default) so the
  // native koffi and noble .node binaries are never bundled. @noble/curves is
  // ESM-only, so it is bundled instead of left to require(esm) at runtime.
  main: {
    build: {
      externalizeDeps: { exclude: ['@noble/curves'] },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'ble-host': resolve(__dirname, 'src/main/ble-host.ts'),
          'smoke-dtek': resolve(__dirname, 'src/main/smoke-dtek.ts'),
          'smoke-ecoflow': resolve(__dirname, 'src/main/smoke-ecoflow.ts'),
          'smoke-ble': resolve(__dirname, 'src/main/smoke-ble.ts'),
        },
        // Shared chunks sit next to the entries, so __dirname is out/main in every module
        // (spawnBleHost's ble-host.js, the ../renderer and ../preload paths).
        output: { chunkFileNames: '[name]-[hash].js' },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          app: resolve(__dirname, 'src/renderer/app.html'),
          widget: resolve(__dirname, 'src/renderer/widget.html'),
        },
      },
    },
  },
});
