import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({
  root: 'src', base: './',
  plugins: [react(), {
    name: 'development-csp-nonce',
    transformIndexHtml(html) {
      return command === 'serve' ? html.replace("script-src 'self'", "script-src 'self' 'nonce-kotoba-dev'") : html;
    },
  }],
  html: { cspNonce: command === 'serve' ? 'kotoba-dev' : undefined },
  build: { outDir: '../dist/renderer', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
}));
