import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxy = {
  '/api': {
    target: process.env.MIB_API_URL ?? 'http://localhost:3001',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  // `vite preview` serves the production bundle (no development controls) against the same API.
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
  optimizeDeps: {
    // MapLibre spawns its worker from a module URL; pre-bundling rewrites that URL and breaks it.
    exclude: ['maplibre-gl'],
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('node_modules/maplibre-gl/')) return 'maplibre';
          return undefined;
        },
      },
    },
  },
});
