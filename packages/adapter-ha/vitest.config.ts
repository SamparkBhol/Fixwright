import { defineConfig } from 'vitest/config';

// Integration tests need a live Home Assistant: scripts/integration.sh starts one, exports HA_URL and
// HA_TOKEN, and runs `vitest run --tags-filter integration`. Without both variables every test tagged
// 'integration' is skipped, so `npm test` stays hermetic.
const haReady = Boolean(process.env['HA_URL'] && process.env['HA_TOKEN']);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration files share one live hub (a power cut in one would land in the other's window), so
    // with a hub configured the files run one after another.
    fileParallelism: !haReady,
    tags: [
      {
        name: 'integration',
        description: 'Runs against a live Home Assistant 2026.9.4 (needs HA_URL and HA_TOKEN).',
        skip: !haReady,
        timeout: 60_000,
      },
      {
        name: 'workerd',
        description: 'Starts wrangler dev on port 8742 and runs the adapter inside workerd (needs a live hub too).',
        skip: !haReady,
        timeout: 120_000,
      },
    ],
  },
});
