import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Everything is bundled locally: no CDN, no remote fonts, no RTL plugin.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  server: {
    proxy: {
      '/api': { target: 'https://127.0.0.1:8443', secure: false },
      '/health': { target: 'https://127.0.0.1:8443', secure: false },
      '/maps': { target: 'https://127.0.0.1:8443', secure: false },
    },
  },
});
