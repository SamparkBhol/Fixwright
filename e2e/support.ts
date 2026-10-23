// Shared pieces of the end to end runs against the real local stack (scripts/dev-up.sh): the stack's
// addresses, a page with the host's test hook, error collection over every frame, screenshots and the
// local ntfy receiver.

import { chromium, type Browser, type BrowserContext, type FrameLocator, type Page, type Response } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HookSnapshot } from '../apps/host/src/hook.ts';

export type { HookSnapshot };

export const SERVER = process.env['FIXWRIGHT_SERVER'] ?? 'http://127.0.0.1:8701';
export const SANDBOX = process.env['FIXWRIGHT_SANDBOX'] ?? 'http://127.0.0.1:8702';
export const NTFY = process.env['FIXWRIGHT_NTFY'] ?? 'http://127.0.0.1:8703';
export const SHOTS = process.env['E2E_SHOTS'] ?? new URL('../docs/screens/', import.meta.url).pathname;
export const VIEWPORT = { width: 1600, height: 1000 };

export interface TraceRow {
  lane: string;
  dir: string;
  kind: string;
  method: string;
  tool: string | null;
  id: string | number | null;
  msg: unknown;
  ms?: number;
}

export interface Household {
  token: string;
  ntfy_topic: string;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  household: Household;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  hook<T>(fn: string, ...args: unknown[]): Promise<T>;
  say(text: string): Promise<HookSnapshot>;
  snap(): Promise<HookSnapshot>;
  trace(): Promise<TraceRow[]>;
  /** The view on screen: the inner iframe inside the sandbox proxy iframe. */
  view(): FrameLocator;
  shot(name: string): Promise<string>;
  demo<T>(path: string, body?: unknown): Promise<T>;
}

export async function launch(): Promise<Browser> {
  await mkdir(SHOTS, { recursive: true });
  return chromium.launch({ headless: true });
}

/**
 * Opens the host page served by the server (same origin /mcp), in a fresh browser context so it mints its
 * own household, and waits for the hook's ready(). Every console error of any frame, page error, failed
 * request and HTTP error answer is recorded.
 */
/**
 * The page's query: test mode, plus the sandbox page when FIXWRIGHT_SANDBOX moves the stack off the dev
 * ports (apps/host/dist has the dev sandbox origin built in; ?sandbox= overrides it).
 */
export const HOST_QUERY: Record<string, string> = { test: '1', ...(process.env['FIXWRIGHT_SANDBOX'] ? { sandbox: `${SANDBOX}/sandbox.html` } : {}) };

export async function openHost(browser: Browser, query: Record<string, string> = HOST_QUERY): Promise<Session> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r: Response) => {
    if (r.status() >= 400) failedRequests.push(`${r.request().method()} ${r.url()} -> ${r.status()}`);
  });
  const minted = page.waitForResponse((r) => r.url() === `${SERVER}/demo/household` && r.request().method() === 'POST');
  await page.goto(`${SERVER}/?${new URLSearchParams(query).toString()}`);
  const household = (await (await minted).json()) as Household;

  const hook = <T>(fn: string, ...args: unknown[]): Promise<T> =>
    page.evaluate(
      async ([name, a]) => {
        const h = (window as unknown as { __fixwright: Record<string, (...x: unknown[]) => unknown> }).__fixwright;
        return (await h[name as string]?.(...(a as unknown[]))) as unknown;
      },
      [fn, args] as const,
    ) as Promise<T>;
  await hook('ready');

  const shot = async (name: string): Promise<string> => {
    // Let entrance animations (bars growing, ticks, fades) finish in every frame, so a shot shows the
    // state a person would see a second later, not a frame in between. Endless ones (a pulse) are skipped.
    await Promise.all(
      page.frames().map((f) =>
        f
          .evaluate(() =>
            Promise.race([
              Promise.all(
                document
                  .getAnimations()
                  .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
                  .map((a) => a.finished.catch(() => undefined)),
              ),
              new Promise((r) => setTimeout(r, 2000)),
            ]).then(() => undefined),
          )
          .catch(() => undefined),
      ),
    );
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const path = join(SHOTS, `${name}.png`);
    await page.screenshot({ path });
    return path;
  };
  const demo = async <T>(path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${SERVER}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${household.token}`, 'content-type': 'application/json', origin: SERVER },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };
  return {
    context,
    page,
    household,
    consoleErrors,
    pageErrors,
    failedRequests,
    hook,
    say: (text) => hook<HookSnapshot>('say', text),
    snap: () => hook<HookSnapshot>('snapshot'),
    trace: () => hook<TraceRow[]>('trace'),
    view: () => page.frameLocator('#view-slot iframe.active:not(.leaving)').frameLocator('iframe'),
    shot,
    demo,
  };
}

export interface ReceivedPush {
  topic: string;
  title: string | null;
  tags: string | null;
  message: string;
  at: string;
}

export async function ntfyReceived(topic: string): Promise<ReceivedPush[]> {
  const r = await fetch(`${NTFY}/_received?topic=${encodeURIComponent(topic)}`);
  return (await r.json()) as ReceivedPush[];
}

/** Text of the view on screen, whitespace folded. */
export async function viewText(s: Session): Promise<string> {
  return (await s.view().locator('body').innerText()).replace(/\s+/g, ' ').trim();
}
