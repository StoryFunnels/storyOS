import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
    // DB tests share one database — run files serially to keep truncation safe.
    fileParallelism: false,
  },
});
