// npm run video:record. Drives the real host (apps/host through window.__fixwright) on a live Fixwright
// server beat by beat and captures 30 fps 1920x1080 frames deterministically.
//
// Playwright's fake clock is paused and each frame advances it by exactly 1/30 s. performance.now stays the
// real clock, so the latencies the host shows are measured ones, not fake clock steps. CSS animations sit on a
// frozen document timeline (CDP Animation.setPlaybackRate 0) and are seeked per frame through the Web
// Animations API in every frame of the page. A live MCP call runs with video time stopped, so network time
// never shows up as dead air.
//
// Output: out/frames.mp4 (video only) and out/record.json.
// Options: --from <s> --to <s> capture only part of the timeline (all actions still run, for the checks).
// Env: FIXWRIGHT_SERVER, FIXWRIGHT_SANDBOX (default: the private stack from scripts/stack.sh up).

import { chromium, type BrowserContext, type CDPSession, type Frame, type Page } from 'playwright';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cameraAt, FULL, sceneAt, type TAction, type Timeline, type TScene } from './src/timeline.ts';
import type { Region } from './src/script.ts';
import { jpegEncoder } from './src/ffmpeg.ts';
import { maskToken } from './src/plain-mcp.ts';
import { findMarks, findNonEnglish, findStandards } from './src/marks.ts';
import { CARDS_HTML, FRAMES_FILE, RECORD_FILE, REPO_DIR, TIMELINE_FILE } from './src/paths.ts';

const SERVER = process.env['FIXWRIGHT_SERVER'] ?? 'http://127.0.0.1:8733';
const SANDBOX = process.env['FIXWRIGHT_SANDBOX'] ?? (process.env['FIXWRIGHT_SERVER'] ? '' : 'http://127.0.0.1:8734/sandbox.html');
/** Page y the opened row's structuredContent line is scrolled to; REGION trace in script.txt starts above it. */
const TRACE_ROW_Y = 212;
const HOLD_END_MS = 600_000;
/** How often the on screen text is read for the third party name check, in frames. */
const SCAN_EVERY = 10;

interface TerminalLine {
  kind: 'cmd' | 'req' | 'res' | 'note';
  text: string;
}

export interface ActionRecord {
  at: number;
  beat: string;
  kind: TAction['kind'];
  detail: string;
  realMs: number;
  virtualMs: number;
  reply?: string;
  tool?: string;
  status?: string;
  expect?: string | null;
  ok: boolean;
  tap?: { x: number; y: number };
}

export interface TextScan {
  t: number;
  marks: string[];
  standards: string[];
  lines: string[];
}

export interface RecordResult {
  server: string;
  household: string;
  chromium: string;
  frames: number;
  fromFrame: number;
  toFrame: number;
  partial: boolean;
  captureSec: number;
  msPerFrame: number;
  actions: ActionRecord[];
  terminal: { command: string; lines: TerminalLine[] } | null;
  mismatches: string[];
  consoleErrors: string[];
  /** Animations first seen past their start: they began while video time was stopped (should be none). */
  animation: { frozenTimelineWorks: boolean | null; sampled: number; late: string[] };
  connected: { protocol: string | null; tools: number | null };
  /** Text inside the camera frame, read every SCAN_EVERY frames; a third party name or a Hindi word fails verify. */
  scan: { samples: number; marks: TextScan[]; standards: string[]; nonEnglish: Array<{ t: number; words: string[] }> };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** Runs `work` while stepping the paused fake clock, so page timers and rAF keep moving; video time does not. */
async function drive<T>(ctx: BrowserContext, work: Promise<T>, label: string, maxMs = 45_000): Promise<{ value: T; virtualMs: number }> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  work.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e: unknown) => {
      settled = true;
      error = e;
    },
  );
  const t0 = performance.now();
  let virtualMs = 0;
  while (!settled) {
    await ctx.clock.runFor(16);
    virtualMs += 16;
    await sleep(2);
    if (performance.now() - t0 > maxMs) throw new Error(`${label}: no answer after ${maxMs} ms`);
  }
  if (error) throw error;
  // The double rAF renders and short timers after a call land before the next frame is taken.
  for (let i = 0; i < 6; i++) {
    await ctx.clock.runFor(16);
    virtualMs += 16;
  }
  return { value: value as T, virtualMs };
}

/** Seeks every animation in one document to video time tMs; first sight of an animation is its birth. */
function seekInFrame(f: Frame, tMs: number): Promise<{ n: number; fresh: number; freshAtZero: number; late: string[] }> {
  return f
    .evaluate((t) => {
      const w = window as unknown as { __vidReg?: WeakMap<Animation, number> };
      const reg = w.__vidReg ?? (w.__vidReg = new WeakMap());
      let n = 0;
      let fresh = 0;
      let freshAtZero = 0;
      const late: string[] = [];
      for (const a of document.getAnimations()) {
        let birth = reg.get(a);
        if (birth === undefined) {
          const ct = typeof a.currentTime === 'number' ? a.currentTime : 0;
          fresh++;
          if (ct < 1) freshAtZero++;
          else late.push(`${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id} ${Math.round(ct)}ms`);
          birth = t - ct;
          reg.set(a, birth);
        }
        a.currentTime = t - birth;
        n++;
      }
      return { n, fresh, freshAtZero, late };
    }, tMs)
    .catch(() => ({ n: 0, fresh: 0, freshAtZero: 0, late: [] as string[] }));
}

async function freezeAnimations(cdp: CDPSession): Promise<void> {
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
}

async function hookCall<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([name, a]) => {
      const h = (window as unknown as { __fixwright: Record<string, (...x: unknown[]) => unknown> }).__fixwright;
      return (await h[name as string]?.(...(a as unknown[]))) as unknown;
    },
    [fn, args] as const,
  ) as Promise<T>;
}

/** The text a viewer can see inside the camera rectangle, across the page and every frame in it. */
async function visibleText(page: Page, cam: Region): Promise<string[]> {
  const out: string[] = [];
  for (const f of page.frames()) {
    let off = { x: 0, y: 0 };
    if (f.parentFrame()) {
      const box = await (await f.frameElement().catch(() => null))?.boundingBox().catch(() => null);
      if (!box) continue;
      off = { x: box.x, y: box.y };
    }
    const lines = await f
      .evaluate(
        ({ cam, off }) => {
          const seen: string[] = [];
          const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
          const range = document.createRange();
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const text = (n.textContent ?? '').trim();
            const parent = n.parentElement;
            if (!text || !parent) continue;
            if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
            range.selectNodeContents(n);
            const inside = [...range.getClientRects()].some(
              (r) => r.width > 0 && r.right + off.x > cam.x && r.left + off.x < cam.x + cam.w && r.bottom + off.y > cam.y && r.top + off.y < cam.y + cam.h,
            );
            if (inside) seen.push(text);
          }
          return seen;
        },
        { cam, off },
      )
      .catch(() => [] as string[]);
    out.push(...lines);
  }
  return out;
}

interface Snap {
  transcript: Array<{ role: string; text: string; tool?: string; status?: string }>;
  approval: unknown;
  viewTool: string | null;
}

function runPlainClient(token: string): Promise<{ command: string; lines: TerminalLine[] }> {
  const url = `${SERVER}/mcp`;
  const command = `node video/src/plain-mcp.ts ${url}`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['video/src/plain-mcp.ts', url], { cwd: REPO_DIR, env: { ...process.env, FIXWRIGHT_TOKEN: token }, timeout: 30_000 }, (err, stdout) => {
      if (err) return reject(new Error(`plain client failed: ${err.message} ${stdout}`));
      const lines: TerminalLine[] = [{ kind: 'cmd', text: command }];
      for (const l of stdout.split('\n')) {
        if (!l.trim()) continue;
        lines.push({ kind: l.startsWith('#') ? 'note' : l.startsWith('>') ? 'req' : 'res', text: l });
      }
      resolve({ command, lines });
    });
  });
}

async function mintHousehold(): Promise<string> {
  const r = await fetch(`${SERVER}/demo/household`, { method: 'POST', headers: { origin: SERVER, 'content-type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(`POST /demo/household: ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

async function main(): Promise<void> {
  const tl = JSON.parse(readFileSync(TIMELINE_FILE, 'utf8')) as Timeline;
  const fromFrame = Math.max(0, Math.round(Number(arg('--from') ?? 0) * tl.fps));
  const toFrame = arg('--to') === undefined ? tl.frames : Math.min(tl.frames, Math.round(Number(arg('--to')) * tl.fps));
  const health = await fetch(`${SERVER}/health`).then((r) => r.json() as Promise<{ ok: boolean; protocol: string; tools: number }>).catch(() => null);
  if (!health?.ok) throw new Error(`no Fixwright server at ${SERVER} (start it with bash video/scripts/stack.sh up)`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: tl.width, height: tl.height }, deviceScaleFactor: 1 });
  // The fake clock replaces performance.now too; these two scripts put the real one back around it.
  await ctx.addInitScript(() => {
    (window as unknown as { __realNow: () => number }).__realNow = performance.now.bind(performance);
  });
  await ctx.clock.install();
  await ctx.addInitScript(() => {
    const real = (window as unknown as { __realNow?: () => number }).__realNow;
    if (real) performance.now = real;
  });
  const consoleErrors: string[] = [];
  const host = await ctx.newPage();
  host.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location().url}`);
  });
  host.on('pageerror', (e) => consoleErrors.push(String(e)));
  const minted = host.waitForResponse((r) => r.url() === `${SERVER}/demo/household` && r.request().method() === 'POST');
  await host.goto(SANDBOX ? `${SERVER}/?sandbox=${encodeURIComponent(SANDBOX)}` : `${SERVER}/`);
  const household = ((await (await minted).json()) as { token: string }).token;
  await hookCall(host, 'ready');
  const cards = await ctx.newPage();
  await cards.goto(pathToFileURL(CARDS_HTML).href);
  await cards.waitForFunction(() => (window as unknown as { __cardsReady?: boolean }).__cardsReady === true);
  await ctx.clock.pauseAt(Date.now() + 1000);

  const cdpHost = await ctx.newCDPSession(host);
  const cdpCards = await ctx.newCDPSession(cards);
  await freezeAnimations(cdpHost);

  const result: RecordResult = {
    server: SERVER,
    household: maskToken(household),
    chromium: browser.version(),
    frames: tl.frames,
    fromFrame,
    toFrame,
    partial: fromFrame > 0 || toFrame < tl.frames,
    captureSec: 0,
    msPerFrame: 0,
    actions: [],
    terminal: null,
    mismatches: [],
    consoleErrors,
    animation: { frozenTimelineWorks: null, sampled: 0, late: [] },
    connected: { protocol: health.protocol, tools: health.tools },
    scan: { samples: 0, marks: [], standards: [], nonEnglish: [] },
  };

  const tapAt = async (page: Page, selector: string, last = false): Promise<{ x: number; y: number } | undefined> => {
    const loc = last ? page.locator(selector).last() : page.locator(selector).first();
    const box = await loc.boundingBox();
    return box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : undefined;
  };

  let replay: { at: number; until: number } | null = null;

  const perform = async (a: TAction): Promise<void> => {
    const t0 = performance.now();
    const rec: ActionRecord = { at: a.at, beat: a.beat, kind: a.kind, detail: '', realMs: 0, virtualMs: 0, ok: true };
    if (a.kind === 'say') {
      rec.detail = a.text;
      rec.expect = a.expect;
      const { value: snap, virtualMs } = await drive(
        ctx,
        host.evaluate(async (text) => {
          const input = document.getElementById('utterance') as HTMLInputElement;
          input.value = text;
          (document.getElementById('composer') as HTMLFormElement).requestSubmit();
          const h = (window as unknown as { __fixwright: { idle(): Promise<unknown> } }).__fixwright;
          return (await h.idle()) as Snap;
        }, a.text),
        `say "${a.text}"`,
      );
      rec.virtualMs = virtualMs;
      const last = [...snap.transcript].reverse().find((e) => e.role === 'assistant');
      rec.reply = last?.text;
      rec.tool = last?.tool;
      rec.status = last?.status;
      if (a.expect !== null && last?.text !== a.expect) {
        rec.ok = false;
        result.mismatches.push(`${a.beat}: "${a.text}" answered "${last?.text}" but the script expects "${a.expect}"`);
      }
      if (snap.approval) result.mismatches.push(`${a.beat}: an approval sheet is open after "${a.text}"`);
    } else if (a.kind === 'device' || a.kind === 'click') {
      const selector = a.kind === 'device' ? `[data-device="${a.device}"]` : a.selector;
      rec.detail = selector;
      rec.tap = await tapAt(host, selector);
      const { virtualMs } = await drive(
        ctx,
        (async () => {
          await host.locator(selector).first().click();
          return hookCall(host, 'idle');
        })(),
        `click ${selector}`,
      );
      rec.virtualMs = virtualMs;
    } else if (a.kind === 'hold') {
      // Held past its end, a moment shows the state before it began (a flash ends where it started).
      rec.detail = `holdMoment(${HOLD_END_MS})`;
      await hookCall(host, 'holdMoment', HOLD_END_MS);
    } else if (a.kind === 'replay') {
      rec.detail = `replay until ${a.until}s`;
      const snap = await hookCall<{ house?: { moment?: { kind: string; frames: number } | null } }>(host, 'snapshot');
      const moment = snap.house?.moment;
      if (!moment || moment.frames === 0) {
        rec.ok = false;
        result.mismatches.push(`${a.beat}: DO replay found no house plan moment to play`);
      } else {
        rec.detail = `replay ${moment.kind}, ${moment.frames} logged frames, until ${a.until}s`;
        replay = { at: a.at, until: a.until };
      }
    } else if (a.kind === 'trace-top') {
      rec.detail = 'trace scrolled to its first message';
      await host.evaluate(() => {
        const first = document.querySelector('.tr');
        let sc = first?.parentElement ?? null;
        while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
        if (sc) sc.scrollTop = 0;
      });
    } else if (a.kind === 'open-trace') {
      const row = `.tr[data-lane="mcp"][data-tool="${a.tool}"]`;
      rec.detail = row;
      const { virtualMs } = await drive(
        ctx,
        (async () => {
          await host.locator(row).last().scrollIntoViewIfNeeded();
          return true;
        })(),
        'scroll trace',
      );
      rec.tap = await tapAt(host, `${row} .tr-head`, true);
      const opened = await drive(ctx, host.locator(`${row} .tr-head`).last().click(), 'open trace row');
      const found = await host.evaluate(
        ([sel, y]) => {
          const rows = document.querySelectorAll(sel);
          const el = rows[rows.length - 1] as HTMLElement | undefined;
          if (!el) return false;
          let top = el.getBoundingClientRect().top;
          let hit = false;
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const i = (n.textContent ?? '').indexOf('"structuredContent"');
            if (i < 0) continue;
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            top = r.getBoundingClientRect().top;
            hit = true;
            break;
          }
          let sc = el.parentElement;
          while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
          if (sc) sc.scrollTop += top - y;
          return hit;
        },
        [row, TRACE_ROW_Y] as const,
      );
      if (!found) {
        rec.ok = false;
        result.mismatches.push(`${a.beat}: the opened ${a.tool} row shows no structuredContent`);
      }
      rec.virtualMs = virtualMs + opened.virtualMs;
    } else if (a.kind === 'terminal') {
      const token = await mintHousehold();
      result.terminal = await runPlainClient(token);
      rec.detail = result.terminal.command;
      if (!result.terminal.lines.some((l) => l.text.includes('"protocolVersion":"2025-11-25"'))) {
        rec.ok = false;
        result.mismatches.push('terminal: initialize did not answer protocolVersion 2025-11-25');
      }
    }
    rec.realMs = Math.round(performance.now() - t0);
    result.actions.push(rec);
    console.log(`  ${a.at.toFixed(2).padStart(7)}s ${a.kind.padEnd(10)} ${rec.realMs.toString().padStart(5)} ms  ${rec.ok ? '' : 'MISMATCH '}${(rec.reply ?? rec.detail).slice(0, 90)}`);
  };

  const standards = new Set<string>();
  const enc = jpegEncoder(FRAMES_FILE, tl.fps);
  const actions = [...tl.actions].sort((x, y) => x.at - y.at);
  let ai = 0;
  let current: TScene | null = null;
  let prevMs = 0;
  let typedFor = '';
  let hostSeeked = false;
  const c0 = performance.now();
  for (let k = 0; k < toFrame; k++) {
    const t = k / tl.fps;
    while (ai < actions.length && (actions[ai] as TAction).at <= t + 1e-6) {
      const a = actions[ai++] as TAction;
      await perform(a);
      // The terminal card shows the plain client's real output, so it is loaded again after the run.
      if (a.kind === 'terminal') current = null;
    }

    const scene = sceneAt(tl, t);
    if (scene !== current) {
      current = scene;
      if (scene.scene.kind === 'card') {
        await cards.evaluate(
          ([s, extras]) => (window as unknown as { __cards: { load(a: unknown, b: unknown): Promise<unknown> } }).__cards.load(s, extras),
          [scene, { terminal: result.terminal }] as const,
        );
        await cards.bringToFront();
      } else {
        await host.bringToFront();
      }
    }
    const capture = k >= fromFrame;
    const isHost = scene.scene.kind === 'host';
    if (isHost) {
      // The words stay in the composer until just before the send action; the form clears them then.
      const ty = tl.typing.find((x) => t >= x.start && t < x.end + 0.2);
      const want = ty ? ty.text.slice(0, Math.round(ty.text.length * Math.min(1, (t - ty.start) / Math.max(0.1, ty.end - ty.start)))) : '';
      if (want !== typedFor) {
        typedFor = want;
        await host.evaluate((v) => {
          const input = document.getElementById('utterance') as HTMLInputElement | null;
          if (input && input.value !== v) input.value = v;
        }, want);
      }
      if (replay) {
        const r: { at: number; until: number } = replay;
        if (t < r.until) await hookCall(host, 'holdMoment', Math.round((t - r.at) * 1000));
        else {
          await hookCall(host, 'holdMoment', null);
          replay = null;
        }
      }
    } else if (capture) {
      await cards.evaluate((tt) => (window as unknown as { __cards: { at(n: number): void } }).__cards.at(tt), t);
    }

    const ms = Math.round((k * 1000) / tl.fps);
    if (ms > prevMs) await ctx.clock.runFor(ms - prevMs);
    prevMs = ms;
    if (!capture) continue;

    const page = isHost ? host : cards;
    const seeks = await Promise.all(page.frames().map((f) => seekInFrame(f, ms)));
    const seekedHost = isHost && hostSeeked;
    if (isHost) hostSeeked = true;
    // The first seek of a page registers what was already running (not a late start), so it is not counted.
    if (isHost && seekedHost) {
      for (const s of seeks) {
        if (s.fresh) {
          result.animation.sampled += s.fresh;
          const works = s.freshAtZero === s.fresh;
          result.animation.frozenTimelineWorks = (result.animation.frozenTimelineWorks ?? true) && works;
          for (const l of s.late) if (result.animation.late.length < 40) result.animation.late.push(`${t.toFixed(2)}s ${l}`);
        }
      }
    }
    const cam = isHost ? cameraAt(tl.cameras, t) : FULL;
    if (k % SCAN_EVERY === 0) {
      const lines = await visibleText(page, cam);
      result.scan.samples++;
      const text = lines.join('\n');
      for (const s of findStandards(text)) standards.add(s);
      const marks = findMarks(text);
      if (marks.length) result.scan.marks.push({ t: +t.toFixed(2), marks, standards: findStandards(text), lines: lines.filter((l) => findMarks(l).length).slice(0, 6) });
      const words = findNonEnglish(text);
      if (words.length) result.scan.nonEnglish.push({ t: +t.toFixed(2), words });
    }
    const shot = (await (isHost ? cdpHost : cdpCards).send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 92,
      optimizeForSpeed: true,
      clip: { x: cam.x, y: cam.y, width: cam.w, height: cam.h, scale: tl.width / cam.w },
    })) as { data: string };
    await enc.write(Buffer.from(shot.data, 'base64'));
    if (k % (tl.fps * 10) === 0) console.log(`frame ${k}/${toFrame} (${t.toFixed(1)}s) ${((performance.now() - c0) / 1000).toFixed(1)}s`);
  }
  await enc.end();
  result.captureSec = +((performance.now() - c0) / 1000).toFixed(2);
  result.msPerFrame = +((performance.now() - c0) / Math.max(1, toFrame - fromFrame)).toFixed(2);
  result.scan.standards = [...standards].sort();
  while (ai < actions.length && !result.partial) await perform(actions[ai++] as TAction);

  await browser.close();
  writeFileSync(RECORD_FILE, JSON.stringify(result, null, 2));
  console.log(
    `record: ${toFrame - fromFrame} frames in ${result.captureSec}s (${result.msPerFrame} ms/frame), ${result.actions.length} actions, ` +
      `${result.mismatches.length} mismatches, ${consoleErrors.length} console errors, frozen timeline ${result.animation.frozenTimelineWorks}, ` +
      `${result.scan.samples} text scans, third party names in ${result.scan.marks.length}, Hindi in ${result.scan.nonEnglish.length}`,
  );
  for (const m of result.mismatches) console.error(`MISMATCH ${m}`);
  for (const m of result.scan.marks.slice(0, 10)) console.error(`NAME ${m.t}s ${m.marks.join(', ')}: ${m.lines.join(' | ').slice(0, 200)}`);
  if (result.mismatches.length) process.exit(1);
}

await main();
