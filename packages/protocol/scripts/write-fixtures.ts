// Regenerates fixtures/<tool>.json from scripts/golden.ts. Run: npm run fixtures -w @fixwright/protocol
// Every fixture is validated before anything is written.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProblemOutputSchema, ToolOutputs, TOOL_NAMES } from '../src/index.ts';
import { fixtureJson, goldenFixtures } from './golden.ts';

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixtures = goldenFixtures();

for (const tool of TOOL_NAMES) ToolOutputs[tool].parse(fixtures[tool]);
ProblemOutputSchema.parse(fixtures.problem);

mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f));
for (const [name, value] of Object.entries(fixtures)) writeFileSync(join(dir, `${name}.json`), fixtureJson(value));
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${dir}`);
