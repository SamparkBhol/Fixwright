import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { escapeScript } from '../../scripts/build.ts';
import { ROOT } from './load.ts';

const VIEWS = ['stepper', 'carousel', 'repair-card'];
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8')) as {
  views: Record<string, { file: string; bytes: number; gzip: number; sha256: string }>;
};

/** Budget for a single view: well under the 608,934 bytes (132,664 gzip) an early prototype view weighed. */
const MAX_BYTES = 420_000;
const MAX_GZIP = 115_000;

describe.each(VIEWS)('dist/%s.html', (view) => {
  const file = path.join(DIST, `${view}.html`);
  const html = existsSync(file) ? readFileSync(file, 'utf8') : '';

  test('exists and is one self contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    expect(css).not.toMatch(/@import\s/);
    expect(css).not.toMatch(/url\(\s*['"]?(https?:)?\/\//i);
    expect(css).not.toMatch(/@font-face/);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
  });

  test('has the mount points the runtime needs', () => {
    for (const id of ['stage', 'app', 'live']) expect(html).toContain(`id="${id}"`);
  });

  test('stays within the size budget, and the manifest matches the file', () => {
    const buf = readFileSync(file);
    const entry = manifest.views[view];
    expect(entry?.bytes).toBe(buf.length);
    expect(entry?.sha256).toBe(createHash('sha256').update(buf).digest('hex'));
    expect(buf.length).toBeLessThan(MAX_BYTES);
    expect(gzipSync(buf, { level: 9 }).length).toBeLessThan(MAX_GZIP);
  });

  test('carries no Alexa or Amazon branding', () => {
    expect(html).not.toMatch(/alexa|amazon/i);
  });

  test('the inline script cannot end or escape its element early, and still parses', () => {
    const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    expect(js).not.toMatch(/<\/script/i);
    expect(js).not.toContain('<!--');
    expect(() => new Script(js)).not.toThrow();
  });
});

describe('escapeScript', () => {
  test('keeps strings, templates and regexes with the u flag meaning the same', () => {
    const src = 'globalThis.out = [/<!--x/u.test("<!--x"), "</script>", `<!--${1}`, /<\\/script>/u.source];';
    const escaped = escapeScript(src);
    expect(escaped).not.toContain('<!--');
    expect(escaped).not.toMatch(/<\/script/i);
    const run = (code: string) => {
      const ctx: { out?: unknown } = {};
      new Script(code.replace('globalThis.out', 'this.out')).runInNewContext(ctx);
      return ctx.out;
    };
    expect(run(escaped)).toEqual(run(src));
  });
});
