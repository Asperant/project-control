import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Source maps are not shipped: they would expose the full unminified panel
    // source to anyone who reaches the portal, for no operational benefit.
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    // Local development only. In a deployment the browser never talks to Vite;
    // it talks to Caddy, which serves the built assets and proxies /api.
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
});
