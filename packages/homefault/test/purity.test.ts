// homefault's source runs unchanged in Node 22, workerd and the browser. No Node
// built-ins, no ambient clock or randomness, no top-level I/O, no @fixwright imports (it is standalone),
// and it bundles for a neutral platform with the conditions wrangler uses for workerd.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const srcDir = new URL('../src/', import.meta.url);

function walk(dir: URL): URL[] {
  return readdirSync(dir).flatMap((name) => {
    const url = new URL(name, dir);
    return statSync(url).isDirectory() ? walk(new URL(`${name}/`, dir)) : name.endsWith('.ts') ? [url] : [];
  });
}

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
const sources = walk(srcDir).map((url) => ({ file: url.pathname.slice(srcDir.pathname.length), text: stripComments(readFileSync(url, 'utf8')) }));

const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/from\s+['"]node:/, 'node: import'],
  [/\brequire\(/, 'require()'],
  [/\bprocess\./, 'process global'],
  [/\bBuffer\b/, 'Buffer'],
  [/\bDate\.now\(/, 'Date.now() (virtual time only)'],
  [/\bnew Date\(\)/, 'new Date() without a time'],
  [/\bMath\.random\(/, 'Math.random() (seeded Rng only)'],
  [/\bcrypto\./, 'crypto'],
  [/\bfetch\(/, 'fetch (no I/O)'],
  [/\b(setTimeout|setInterval)\(/, 'timers'],
  [/\bclass\s+\w+/, 'classes (plain functions and data only)'],
  [/@fixwright\//, '@fixwright imports (homefault is standalone)'],
];

describe('homefault source purity', () => {
  it('found the source files', () => {
    expect(sources.map((s) => s.file)).toContain('index.ts');
    expect(sources.length).toBeGreaterThan(15);
  });

  it.each(FORBIDDEN)('no %s', (pattern, what) => {
    const hits = sources.filter((s) => pattern.test(s.text)).map((s) => s.file);
    expect(hits, `${what} in ${hits.join(', ')}`).toEqual([]);
  });

  it('the only runtime global it touches is performance.now, as the default bench timer', () => {
    const hits = sources.filter((s) => /globalThis/.test(s.text)).map((s) => s.file);
    expect(hits).toEqual(['bench.ts']);
  });

  it('has no runtime dependencies', () => {
    const external = new Set<string>();
    for (const { text } of sources) {
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) if (!m[1]?.startsWith('.')) external.add(m[1] as string);
    }
    expect([...external]).toEqual([]);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies?: object };
    expect(pkg.dependencies).toBeUndefined();
  });

  it.each(['index.ts', 'incidents.ts'])('%s bundles for a neutral platform with workerd conditions', async (entry) => {
    const result = await build({
      entryPoints: [new URL(entry, srcDir).pathname],
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
    expect(Object.keys(result.metafile.inputs).some((i) => i.startsWith('node:'))).toBe(false);
    const bytes = result.outputFiles[0]?.contents.byteLength ?? 0;
    expect(bytes).toBeGreaterThan(20_000);
    expect(bytes).toBeLessThan(1_000_000);
  });
});
