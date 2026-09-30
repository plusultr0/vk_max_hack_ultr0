import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', port: 5173,
    proxy: Object.fromEntries(['/admin', '/auth', '/company', '/impacts', '/actions', '/regulatory', '/audit', '/notifications', '/health']
      .map(prefix => [prefix, { target, changeOrigin: true }])),
  },
});
