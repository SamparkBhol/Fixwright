import { defineConfig } from 'vitest/config';

// End to end against the real local stack (scripts/dev-up.sh): wrangler dev --local for the server and the
// sandbox, the host page served by the server, headless Chromium. One file at a time, in order.
export default defineConfig({
  test: {
    root: new URL('.', import.meta.url).pathname,
    include: [process.env['E2E_INCLUDE'] ?? 'golden.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    sequence: { concurrent: false },
  },
});
