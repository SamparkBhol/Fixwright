//   node scripts/build.ts            views and harness
//   node scripts/build.ts --views    views only
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { zodEnglishOnly } from './zod-english-only.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HARNESS_OUT = path.join(ROOT, 'test', 'harness', 'out');

export const VIEWS = [
  { name: 'stepper', entry: 'src/stepper.ts', title: 'Fixwright diagnosis' },
  { name: 'carousel', entry: 'src/carousel.ts', title: 'Fixwright home checkup' },
  { name: 'repair-card', entry: 'src/repair-card.ts', title: 'Fixwright repair' },
] as const;

export interface BuiltFile {
  file: string;
  bytes: number;
  gzip: number;
  sha256: string;
  scriptBytes: number;
  styleBytes: number;
}

/**
 * Inline script text must not end its element early ("</script") or enter the HTML parser's escaped
 * state ("<!--"). Both only occur inside string, template or regex literals in minified output, so each
 * gets an escape that means the same in all three, including regexes with the u flag: "<\/" (an escaped
 * slash) and "\x3C" for "<" ("<\!" would be a syntax error in a regex with the u flag).
 */
export const escapeScript = (js: string) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '\\x3C!--');
export const escapeStyle = (css: string) => css.replace(/<\/(style)/gi, '<\\/$1');

async function buildView(view: (typeof VIEWS)[number], template: string): Promise<BuiltFile> {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, view.entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022', 'chrome111'],
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    outdir: path.join(DIST, 'tmp'),
    plugins: [zodEnglishOnly()],
    logLevel: 'warning',
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  if (!js || !css) throw new Error(`${view.name}: missing ${js ? 'css' : 'js'} output`);
  const html = template
    .replace('<!--TITLE-->', () => view.title)
    .replace('<!--STYLE-->', () => escapeStyle(css.trim()))
    .replace('<!--SCRIPT-->', () => escapeScript(js.trim()));
  const file = `${view.name}.html`;
  const buf = Buffer.from(html, 'utf8');
  await writeFile(path.join(DIST, file), buf);
  return {
    file,
    bytes: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    scriptBytes: Buffer.byteLength(js),
    styleBytes: Buffer.byteLength(css),
  };
}

async function buildHarness(): Promise<void> {
  await mkdir(HARNESS_OUT, { recursive: true });
  const common = { bundle: true, platform: 'browser', target: 'es2022', minify: false, legalComments: 'none', logLevel: 'warning' } as const;
  await esbuild.build({ ...common, entryPoints: [path.join(ROOT, 'test/harness/host.ts')], format: 'esm', outfile: path.join(HARNESS_OUT, 'host.js') });
  const sandbox = await esbuild.build({ ...common, entryPoints: [path.join(ROOT, 'test/harness/sandbox.ts')], format: 'iife', write: false });
  const sandboxHtml = (await readFile(path.join(ROOT, 'test/harness/sandbox.html'), 'utf8')).replace(
    '<!--SANDBOX_SCRIPT-->',
    () => `<script>${escapeScript(sandbox.outputFiles[0]?.text ?? '')}</script>`,
  );
  await writeFile(path.join(HARNESS_OUT, 'sandbox.html'), sandboxHtml);
}

export async function build(opts: { harness: boolean }): Promise<Record<string, BuiltFile>> {
  const t0 = performance.now();
  await mkdir(DIST, { recursive: true });
  const template = await readFile(path.join(ROOT, 'src/ui/template.html'), 'utf8');
  const built = await Promise.all(VIEWS.map((v) => buildView(v, template)));
  const manifest = Object.fromEntries(VIEWS.map((v, i) => [v.name, built[i] as BuiltFile]));
  await writeFile(path.join(DIST, 'manifest.json'), `${JSON.stringify({ version: '0.1.0', views: manifest }, null, 2)}\n`);
  if (opts.harness) await buildHarness();
  const ms = Math.round(performance.now() - t0);
  for (const [name, b] of Object.entries(manifest)) {
    console.log(`${name.padEnd(12)} ${String(b.bytes).padStart(7)} bytes  ${String(b.gzip).padStart(6)} gzip  sha256 ${b.sha256.slice(0, 12)}`);
  }
  console.log(`built in ${ms} ms${opts.harness ? ' (with harness)' : ''}`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build({ harness: !process.argv.includes('--views') });
}
