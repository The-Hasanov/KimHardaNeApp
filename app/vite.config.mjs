import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const ui = path.resolve(import.meta.dirname, 'ui');
export default defineConfig({
  root: ui,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': ui } },
  build: { outDir: path.resolve(import.meta.dirname, 'renderer'), emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
