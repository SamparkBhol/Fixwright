// npm run build (apps/server), also run by npm run deploy: writes src/household/demo-template.json, the
// demo house the Worker rebases for every new household. SimHome is deterministic, so an unchanged
// homefault gives the same file and nothing is written. test/unit/template.test.ts fails when it is stale.
//
// Usage: node scripts/build-template.ts [--check]   (--check exits 1 instead of writing)

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTemplate } from '../src/household/template-build.ts';

const OUT = fileURLToPath(new URL('../src/household/demo-template.json', import.meta.url));

const t0 = performance.now();
const { template } = await buildTemplate();
const text = `${JSON.stringify(template)}\n`;
const ms = performance.now() - t0;
let current = '';
try {
  current = readFileSync(OUT, 'utf8');
} catch {
  current = '';
}
const state = current === text ? 'up to date' : 'changed';
console.log(`demo template: seed ${template.seed}, ${template.start}, ${Object.keys(template.snapshot.entities).length} entities, ${text.length} bytes, built in ${ms.toFixed(1)} ms, ${state}`);
if (state === 'changed') {
  if (process.argv.includes('--check')) process.exit(1);
  writeFileSync(`${OUT}.partial`, text);
  renameSync(`${OUT}.partial`, OUT);
}
