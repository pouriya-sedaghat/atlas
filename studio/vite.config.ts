import { defineConfig } from 'vitest/config';

// Studio never talks to the Atlas server cross-origin. The dev server proxies
// /api and /health instead, which keeps the backend free of permissive CORS.
const atlasServer = process.env.ATLAS_SERVER_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: atlasServer, changeOrigin: false },
      '/health': { target: atlasServer, changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': { target: atlasServer, changeOrigin: false },
      '/health': { target: atlasServer, changeOrigin: false },
    },
  },
  worker: {
    // MapLibre's worker is an ES module and imports a shared chunk.
    format: 'es',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
