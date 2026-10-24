import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite's default leaves out .cts, so the preload (src/app/preload/preload.cts) would load untransformed.
  oxc: { include: /\.([cm]?ts|[jt]sx)$/ },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/e2e/**', 'test/app/renderer/**', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['test/app/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['test/app/renderer/setup.ts'],
        },
      },
    ],
  },
});
