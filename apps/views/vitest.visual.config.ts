import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/visual/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
