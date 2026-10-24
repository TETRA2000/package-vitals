import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite's default leaves out .cts, so the preload (src/app/preload/preload.cts) would load untransformed.
  oxc: { include: /\.([cm]?ts|[jt]sx)$/ },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
