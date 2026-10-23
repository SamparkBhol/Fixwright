import { defineConfig } from 'vitest/config';

// Browser end-to-end tests: three local origins (host, sandbox, mock MCP server) and headless Chromium.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
