import { defineConfig } from 'vitest/config';

// test/unit: pure helpers and the household on node:sqlite (fast, hermetic).
// test/integration: starts `wrangler dev --local` on ports 8701 to 8708 and drives the real Worker.
// The Home Assistant run (tag 'ha') needs FIXWRIGHT_HA=1 and a hub started by scripts/ha-run.sh.
const haReady = process.env['FIXWRIGHT_HA'] === '1';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration files start their own wrangler on fixed ports, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    tags: [{ name: 'ha', description: 'Links a household to a local Home Assistant 2026.9.4 (port 8741).', skip: !haReady, timeout: 180_000 }],
  },
});
