// esbuild plugin: zod's classic entry reexports every locale (`export * as locales`), which puts about
// 260 KB of translated error messages into a bundle that only ever needs English. This resolves zod's
// internal `../locales/index.js` to a module that exports `en` alone. Measured: a minimal App view drops
// from 599,473 to 338,285 bytes (129,117 to 90,307 gzip). zod itself still calls config(en()).
import path from 'node:path';
import type { Plugin } from 'esbuild';

export function zodEnglishOnly(): Plugin {
  return {
    name: 'zod-english-only',
    setup(b) {
      b.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (args) => {
        const fromZod = args.importer.split(path.sep).join('/').includes('/zod/v4/');
        return fromZod ? { path: path.join(args.resolveDir, '../locales/en.js'), namespace: 'zod-locales' } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: 'zod-locales' }, (args) => ({
        contents: `export { default as en } from ${JSON.stringify(args.path)};`,
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }));
    },
  };
}
