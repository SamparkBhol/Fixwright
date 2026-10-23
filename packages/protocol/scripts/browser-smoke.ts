// Proves the protocol bundle runs unchanged in a real browser: bundles src/index.ts for the browser
// with esbuild, loads it into headless Chromium (Playwright 1.63, preinstalled browsers) and calls the
// helpers there. Run: npm run smoke:browser -w @fixwright/protocol

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const fixture = readFileSync(new URL('../fixtures/diagnose_answer.json', import.meta.url), 'utf8');

const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'Fixwright', platform: 'browser' });
const code = bundle.outputFiles[0]!.text;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent('<!doctype html><title>protocol smoke</title>');
  await page.addScriptTag({ content: code });
  const result = await page.evaluate((json) => {
    const F = (globalThis as unknown as { Fixwright: typeof import('../src/index.ts') }).Fixwright;
    return {
      userAgent: navigator.userAgent,
      tools: F.TOOL_NAMES.length,
      fixtureValid: F.ToolOutputs.diagnose_answer.safeParse(JSON.parse(json)).success,
      yes: F.parseYesNo('हाँ, जल गया'),
      no: F.parseYesNo('nahi jala'),
      speech: F.speechSafe('Hub ok | light.hallway_lamp is back'),
      id: F.newId('dx', F.manualClock('2026-10-15T17:20:04.000Z'), F.seededRng(1)),
    };
  }, fixture);
  console.log(JSON.stringify({ bundleBytes: code.length, ...result, pageErrors: errors }, null, 2));
  const ok = result.tools === 11 && result.fixtureValid && result.yes === 'yes' && result.no === 'no' && errors.length === 0;
  if (!ok) throw new Error('browser smoke failed');
} finally {
  await browser.close();
}
