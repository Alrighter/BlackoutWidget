import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Dependencies of main/preload stay external (electron-vite default) so the
  // native koffi .node binary is never bundled.
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'smoke-dtek': resolve(__dirname, 'src/main/smoke-dtek.ts'),
        },
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
