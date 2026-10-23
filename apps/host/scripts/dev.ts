// Local demo: builds the host and starts the three origins (host, sandbox, mock server) on
// 8711, 8712 and 8713. Open the printed URL in a browser. Ctrl+C stops everything.
// Run: npm run dev -w @fixwright/host

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { startStack } from '../test/support/stack.ts';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
execFileSync(process.execPath, [join(root, 'scripts', 'build.ts')], { stdio: 'inherit' });

const stack = await startStack({ views: (process.env['VIEWS'] as 'auto' | 'dist' | 'placeholder' | undefined) ?? 'auto' });
console.log(`\nFixwright host simulator (mock server, views: ${stack.mock.viewSource})`);
console.log(`  open ${stack.pageUrl()}\n`);

const stop = (): void => {
  void stack.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
