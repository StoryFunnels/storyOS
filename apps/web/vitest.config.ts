import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * MN-135: unit tests for pure web logic (paste rules, the permission ladder).
 * `node` environment — these helpers don't touch the DOM, so no jsdom needed.
 * The `@` alias mirrors tsconfig so imports resolve the same as the app.
 *
 * #251: a few of these tests import real components and render them with
 * react-dom/server (no jsdom/RTL — not set up in this repo, and a static
 * render is enough to assert on markup). tsconfig sets `jsx: "preserve"`
 * because Next's own compiler does the JSX transform for the app build; Vite
 * respects that for esbuild too, so it needs to be told explicitly to
 * compile JSX for this test run instead of leaving it untransformed.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.unit.test.ts'],
  },
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
