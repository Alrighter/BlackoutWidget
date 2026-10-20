import { defineConfig } from 'vitest/config';

export default defineConfig({
  // settlements.json sits next to settlements.ts: resolve `./settlements` to the .ts first.
  resolve: { extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'] },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    globals: true,
    setupFiles: ['@testing-library/jest-dom/vitest'],
  },
});
