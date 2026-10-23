// Builds the host simulator into dist/: index.html, app.js (one ESM bundle), app.css and the self hosted
// fonts with their licenses in fonts/.
//   SANDBOX_URL  sandbox proxy page on its own origin (default http://127.0.0.1:8712/sandbox.html)
//   SERVER_URL   Fixwright server base URL (default: same origin as the page, as when apps/server serves dist/)

import { build } from 'esbuild';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };

const define = {
  __SANDBOX_URL__: JSON.stringify(process.env['SANDBOX_URL'] ?? 'http://127.0.0.1:8712/sandbox.html'),
  __SERVER_URL__: JSON.stringify(process.env['SERVER_URL'] ?? ''),
  __HOST_VERSION__: JSON.stringify(pkg.version),
};

const t0 = performance.now();
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const js = await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  define,
  outfile: join(dist, 'app.js'),
  metafile: true,
  logLevel: 'warning',
});
await build({
  entryPoints: [join(root, 'src', 'styles.css')],
  bundle: true,
  minify: true,
  outfile: join(dist, 'app.css'),
  loader: { '.woff2': 'file' },
  assetNames: 'fonts/[name]',
  logLevel: 'warning',
});
await copyFile(join(root, 'src', 'index.html'), join(dist, 'index.html'));
await copyFile(join(root, 'src', 'dashboard.html'), join(dist, 'dashboard.html'));
await copyFile(join(root, 'src', '_headers'), join(dist, '_headers'));
await mkdir(join(dist, 'fonts'), { recursive: true });
for (const f of await readdir(join(root, 'src', 'fonts'))) {
  if (f.endsWith('.txt')) await copyFile(join(root, 'src', 'fonts', f), join(dist, 'fonts', f));
}
const ms = Math.round(performance.now() - t0);

const size = async (f: string): Promise<{ bytes: number; gzip: number }> => {
  const b = await readFile(join(dist, f));
  return { bytes: (await stat(join(dist, f))).size, gzip: gzipSync(b, { level: 9 }).length };
};
/** Minified bytes in app.js per package (esbuild metafile), largest first. */
const byPackage = (): Record<string, number> => {
  const out = Object.values(js.metafile.outputs).find((o) => o.entryPoint !== undefined);
  const sums = new Map<string, number>();
  for (const [file, info] of Object.entries(out?.inputs ?? {})) {
    const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file);
    const ws = /(?:^|\/)(packages|apps)\/([^/]+)\//.exec(file);
    // Metafile paths are relative to this app, so its own sources start with src/.
    const key = nm?.[1] ?? (ws ? `${ws[1]}/${ws[2]}` : file.startsWith('src/') ? 'apps/host' : file);
    sums.set(key, (sums.get(key) ?? 0) + info.bytesInOutput);
  }
  return Object.fromEntries([...sums].sort((a, b) => b[1] - a[1]));
};
const report = {
  build_ms: ms,
  app_js: await size('app.js'),
  app_css: await size('app.css'),
  index_html: await size('index.html'),
  inputs: Object.keys(js.metafile.inputs).length,
  by_package: byPackage(),
};
console.log(JSON.stringify(report));
console.log(`host build: app.js ${report.app_js.bytes} B (${report.app_js.gzip} B gzip), app.css ${report.app_css.bytes} B, ${ms} ms`);
