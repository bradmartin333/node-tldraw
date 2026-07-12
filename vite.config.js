import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-only server config: in production the sync server serves the built
// dist/ itself, so the app, API and websocket are all same-origin on one port.
// In dev the sync server runs standalone on 8787 (`npm run sync-server`) and
// vite proxies API + websocket traffic to it, so the client code can use the
// same relative URLs in both environments.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
      '/sync': {
        target: 'ws://localhost:8787',
        ws: true,
      },
    },
  },
})
