import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const rootDir = path.resolve(import.meta.dirname, '../..');

// The root .env is shared with the API. Vite only exposes variables prefixed with VITE_ to the
// browser bundle, so server secrets in the same file never reach the client. The dev-server proxy
// reads API_PORT here (server side only) so /api always reaches the local API.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '');
  const apiTarget = `http://localhost:${env.API_PORT || '4000'}`;
  return {
    envDir: rootDir,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, 'src') },
    },
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin API calls in development: cookies and the CSRF Origin check behave as in production.
      proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    },
    preview: {
      port: 4173,
      proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      // The entry chunk carries React, the router, TanStack Query and the prerendered marketing and auth
      // pages (about 180 KB gzipped); dashboard pages and charts are separate lazy chunks.
      chunkSizeWarningLimit: 700,
    },
    ssr: {
      // Workspace packages ship TypeScript sources, so bundle them into the prerender build.
      noExternal: ['@surfaced/shared'],
    },
  };
});
