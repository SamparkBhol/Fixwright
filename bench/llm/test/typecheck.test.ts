// bench's `npm run check` typechecks only bench/{src,test,scripts}, but its vitest run picks up this
// folder's tests, so running tsc on bench/llm from a test is what gets its types checked. tsc runs by
// absolute project path: `npx tsc -p tsconfig.json` from this folder would silently check
// bench/tsconfig.json, because npx runs from the workspace root.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const project = resolve(here, '../tsconfig.json');

it('bench/llm typechecks (tsc -p bench/llm/tsconfig.json)', { timeout: 120_000 }, () => {
  const listed = spawnSync(process.execPath, [tsc, '-p', project, '--listFilesOnly'], { encoding: 'utf8' });
  // Guard against checking the wrong project: this folder's own sources must be in the program.
  expect(listed.stdout).toContain(resolve(here, '../src/strands-client.ts'));
  const r = spawnSync(process.execPath, [tsc, '-p', project], { encoding: 'utf8' });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
});
