import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 127.0.0.1 rather than localhost on purpose: since Node 17 the resolver order is no longer
// reordered, so on some systems (Windows in particular) `localhost` resolves to ::1 first and a
// proxy hop can fail even though the API is running. The API binds dual-stack, so the explicit
// IPv4 address always reaches it. Override with MIB_API_URL when the API lives elsewhere.
const apiTarget = process.env.MIB_API_URL ?? 'http://127.0.0.1:3001';
// The public legal pages and the support page are server-rendered by the API. Proxying them
// here gives development the single origin a production deployment serves, so an in-app link
// to /support resolves the same way in both.
const apiProxy = {
  '/api': { target: apiTarget, changeOrigin: true },
  '/legal': { target: apiTarget, changeOrigin: true },
  '/support': { target: apiTarget, changeOrigin: true },
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
