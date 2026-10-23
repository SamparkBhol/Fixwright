// The protocol must run unchanged in Node 22, workerd and the browser. These tests prove the
// source has no Node built in modules, no ambient clock or randomness and no top level I/O, and that it bundles
// for a neutral platform with the same export conditions wrangler uses for workerd.

import { readdirSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const srcDir = new URL('../src/', import.meta.url);

/** Code without comments, so prose like "inject crypto.getRandomValues" is not a hit. Keeps "ui://". */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: stripComments(readFileSync(new URL(f, srcDir), 'utf8')) }));

const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/from\s+['"]node:/, 'node: import'],
  [/\brequire\(/, 'require()'],
  [/\bprocess\./, 'process global'],
  [/\bBuffer\b/, 'Buffer'],
  [/\bDate\.now\(/, 'Date.now() (inject a Clock)'],
  [/\bnew Date\(\)/, 'new Date() without a time (inject a Clock)'],
  [/\bMath\.random\(/, 'Math.random() (inject an Rng)'],
  [/\bcrypto\./, 'crypto (inject an Rng)'],
  [/\bfetch\(/, 'fetch (no I/O in protocol)'],
  [/\b(setTimeout|setInterval)\(/, 'timers'],
  [/\b(window|document|globalThis)\./, 'runtime globals'],
];

describe('protocol source purity', () => {
  it('found the source files', () => {
    expect(sources.map((s) => s.file)).toContain('index.ts');
  });

  it.each(FORBIDDEN)('no %s', (pattern, what) => {
    const hits = sources.filter((s) => pattern.test(s.text)).map((s) => s.file);
    expect(hits, `${what} in ${hits.join(', ')}`).toEqual([]);
  });

  it('only imports zod from outside the package', () => {
    const external = new Set<string>();
    for (const { text } of sources) {
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) if (!m[1]!.startsWith('.')) external.add(m[1]!);
    }
    expect([...external]).toEqual(['zod/v4']);
  });

  it('bundles for a neutral platform with workerd conditions, without Node built in modules', async () => {
    const result = await build({
      entryPoints: [new URL('index.ts', srcDir).pathname],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      conditions: ['workerd', 'worker', 'browser'],
      metafile: true,
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((i) => i.startsWith('node:'))).toBe(false);
    const bytes = result.outputFiles[0]!.contents.byteLength;
    expect(bytes).toBeGreaterThan(10_000);
    // Rough guard so the contract stays small enough for a Worker and a single file view.
    expect(bytes).toBeLessThan(1_500_000);
  });
});
