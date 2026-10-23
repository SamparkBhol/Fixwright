// Writes src/generated/proxy-script.ts from src/proxy.ts. Part of `npm run check` and `npm run build`.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GENERATED_PATH, bundleProxy, generatedModule } from './bundle-proxy.ts';

const next = generatedModule(await bundleProxy());
const prev = await readFile(GENERATED_PATH, 'utf8').catch(() => '');
if (prev !== next) {
  await mkdir(dirname(GENERATED_PATH), { recursive: true });
  await writeFile(GENERATED_PATH, next);
}
console.log(`sandbox proxy script: ${next.length} bytes${prev === next ? ' (unchanged)' : ' (written)'}`);
