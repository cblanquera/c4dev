import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { loadToken, withToken } from './server/auth.ts';

/** In development Vite serves index.html, so it writes the API token in, as the server does in production. */
const apiToken = (): Plugin => ({
  name: 'factory-api-token',
  apply: 'serve',
  transformIndexHtml: (html) => withToken(html, loadToken(path.resolve(process.env.FACTORY_DATA ?? '.factory'))),
});

// The proxy keeps the browser's Host, so the API sees requests from the page's own origin.
const api = { target: 'http://localhost:4400', changeOrigin: false };

export default defineConfig({
  root: 'web',
  plugins: [react(), apiToken()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    // Other localhost pages must not read index.html (it carries the token).
    cors: false,
    proxy: { '/api': api, '/uploads': api },
  },
});
