// Run: node scripts/write-fixtures.ts (test/unit/fixtures.test.ts fails if the files drift).
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolOutputs } from '@fixwright/protocol';
import { FIXTURE_TOOL, viewFixtures, type ViewFixtures } from './view-fixtures.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function serialize(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

const all = viewFixtures();
await mkdir(DIR, { recursive: true });
for (const [name, value] of Object.entries(all) as [keyof ViewFixtures, unknown][]) {
  const tool = FIXTURE_TOOL[name];
  const parsed = ToolOutputs[tool].safeParse(value);
  if (!parsed.success) throw new Error(`${name} does not match ${tool}: ${parsed.error.message}`);
  await writeFile(path.join(DIR, `${name}.json`), serialize(value));
  console.log(`wrote fixtures/${name}.json (${tool})`);
}
