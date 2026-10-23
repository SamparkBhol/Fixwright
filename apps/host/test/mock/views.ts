// The three ui:// view resources for the mock server: the real single file views from
// apps/views/dist when they are built, otherwise one placeholder view bundled here with esbuild.

import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VIEW_URIS, type ViewKind } from '@fixwright/protocol';

const HERE = dirname(new URL(import.meta.url).pathname);
export const VIEWS_DIST = join(HERE, '..', '..', '..', 'views', 'dist');
const FILES: Record<ViewKind, string> = { stepper: 'stepper.html', carousel: 'carousel.html', repair_card: 'repair-card.html' };

export type ViewSource = 'dist' | 'placeholder';
export interface ViewBundle {
  source: ViewSource;
  html: Record<ViewKind, string>;
  byUri: Map<string, string>;
}

let placeholderCache: Promise<string> | undefined;

export function placeholderHtml(): Promise<string> {
  placeholderCache ??= (async () => {
    const result = await build({
      entryPoints: [join(HERE, '..', 'placeholder-view', 'view.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      legalComments: 'none',
    });
    const js = (result.outputFiles[0]?.text ?? '').replace(/<\/script/gi, '<\\/script');
    const css = await readFile(join(HERE, '..', 'placeholder-view', 'view.css'), 'utf8');
    return [
      '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>Fixwright placeholder view</title>',
      `<style>${css}</style></head>`,
      '<body><main id="canvas" data-kind="loading"></main>',
      `<script>${js}</script></body></html>`,
    ].join('');
  })();
  return placeholderCache;
}

/** mode 'auto' uses apps/views/dist when all three files exist. */
export async function loadViews(mode: 'auto' | ViewSource = 'auto'): Promise<ViewBundle> {
  const distReady = Object.values(FILES).every((f) => existsSync(join(VIEWS_DIST, f)));
  const useDist = mode === 'dist' || (mode === 'auto' && distReady);
  const html = {} as Record<ViewKind, string>;
  if (useDist) {
    for (const [kind, file] of Object.entries(FILES) as Array<[ViewKind, string]>) html[kind] = await readFile(join(VIEWS_DIST, file), 'utf8');
  } else {
    const ph = await placeholderHtml();
    for (const kind of Object.keys(FILES) as ViewKind[]) html[kind] = ph;
  }
  const byUri = new Map<string, string>();
  for (const kind of Object.keys(FILES) as ViewKind[]) byUri.set(VIEW_URIS[kind], html[kind]);
  return { source: useDist ? 'dist' : 'placeholder', html, byUri };
}
