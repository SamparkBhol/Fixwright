// The router is a pure package: no Node built in modules, no clock, no randomness, no I/O,
// so the same code runs in the host bundle, in workerd behind /assistant/route, and in Node tests.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

describe('purity', () => {
  it('has source files', () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(`${f} uses no I/O, clock, randomness or Node built in modules`, () => {
      const code = readFileSync(join(SRC, f), 'utf8');
      expect(code).not.toMatch(/\bfrom ['"]node:/);
      expect(code).not.toMatch(/\bDate\.now\(|new Date\(|Math\.random\(|\bfetch\(|\bprocess\.|\bsetTimeout\(/);
    });
  }
});
