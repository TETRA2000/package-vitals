import { defineConfig } from 'vitest/config';

// The end-to-end run: it launches the built app (`npm run build` first), so it stays out of `npm test`.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    // beforeAll launches Electron, which can take a while on a cold CI runner.
    hookTimeout: 60_000,
  },
});
