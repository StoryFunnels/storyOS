import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * MN-135: unit tests for pure web logic (paste rules, the permission ladder).
 * `node` environment — these helpers don't touch the DOM, so no jsdom needed.
 * The `@` alias mirrors tsconfig so imports resolve the same as the app.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.unit.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
