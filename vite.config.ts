import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/app/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(import.meta.dirname, 'dist/app/renderer'),
    emptyOutDir: true,
  },
});
