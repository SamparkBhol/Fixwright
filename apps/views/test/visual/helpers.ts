// The view frame sits at depth 2: host page > sandbox proxy > view.
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import type { Scenario } from '../harness/host.ts';

export type Size = 'large' | 'small' | 'phone';
export const SIZES: Record<Size, { width: number; height: number }> = {
  large: { width: 1280, height: 800 },
  small: { width: 960, height: 480 },
  phone: { width: 390, height: 844 },
};

export interface Session {
  page: Page;
  errors: string[];
  warnings: string[];
  /** Requests made by the view frame itself (must stay empty: CSP safe, no network). */
  viewRequests: string[];
  close(): Promise<void>;
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

function depth(frame: Frame): number {
  let d = 0;
  for (let f = frame.parentFrame(); f; f = f.parentFrame()) d++;
  return d;
}

export async function openSession(browser: Browser, hostUrl: string, size: Size, opts: { reducedMotion?: boolean; touch?: boolean } = {}): Promise<Session> {
  const context = await browser.newContext({
    viewport: SIZES[size],
    deviceScaleFactor: 1,
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
    // A touch screen: taps dispatch real touch events (Playwright tap needs hasTouch).
    ...(opts.touch ? { hasTouch: true } : {}),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const warnings: string[] = [];
  const viewRequests: string[] = [];
  page.on('console', (m) => {
    const where = `${m.location().url || 'inline'}`;
    if (m.type() === 'error') errors.push(`${m.text()} (${where})`);
    // Chrome warns once per sandbox iframe that allow-scripts plus allow-same-origin can escape; the
    // MCP Apps spec requires both flags on the proxy, so that warning is expected and not counted.
    else if (m.type() === 'warning' && !m.text().includes('can escape its sandboxing')) warnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const f = r.frame();
    if (f && depth(f) >= 2) viewRequests.push(r.url());
  });
  await page.goto(`${hostUrl}&bare=1`);
  await page.waitForFunction(() => typeof window.__harness?.load === 'function');
  return { page, errors, warnings, viewRequests, close: () => context.close() };
}

export async function load(page: Page, s: Scenario): Promise<Frame> {
  await page.evaluate((sc) => window.__harness.load(sc), s);
  return viewFrame(page);
}

export async function viewFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if (depth(f) !== 2) continue;
      const ok = await f.evaluate(() => Boolean(document.getElementById('app'))).catch(() => false);
      if (ok) return f;
    }
    await page.waitForTimeout(25);
  }
  throw new Error('view frame not found');
}

/** Waits until the view reported its paint after the latest result (double rAF inside the view). */
export async function waitPainted(frame: Frame): Promise<number> {
  const handle = await frame.waitForFunction(() => Number(document.documentElement.dataset.paintedAt ?? 0) || null, null, { timeout: 10_000 });
  return Number(await handle.jsonValue());
}

/** Waits for animations to settle so screenshots and contrast reads see final colors. */
export async function settle(frame: Frame): Promise<void> {
  await frame.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime as number));
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

export interface Audit {
  zoom: number;
  overflowX: number;
  offscreen: string[];
  smallTargets: string[];
  unnamedControls: string[];
  lowContrast: string[];
  textChecked: number;
  minContrast: number;
  contentOverflowY: number;
  /** How far content reaches into the card's bottom padding (px); 0 when everything sits inside. */
  bottomBleed: number;
  /** Rendered px a decision card's content reaches into its bottom padding or past it. */
  decisionSpill: number;
  /** The card's own scroll position: a fixed landscape card must never be scrolled (focus, for one). */
  cardScrollTop: number;
  /** Decision fit steps the view applied (fitDecision: 0 when the card holds everything as designed). */
  decisionFit: number;
  clippedText: string[];
}

/** Runs inside the view frame. Self contained, because Playwright serializes this function. */
export function auditInPage(): Audit {
  const parse = (c: string): [number, number, number, number] | null => {
    let m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m?.[1]) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
    }
    m = c.match(/^color\(srgb ([^)]+)\)$/);
    if (m?.[1]) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return [(p[0] ?? 0) * 255, (p[1] ?? 0) * 255, (p[2] ?? 0) * 255, p[3] ?? 1];
    }
    return null;
  };
  const over = (top: number[], bottom: number[]): number[] => {
    const a = top[3] ?? 1;
    return [0, 1, 2].map((i) => (top[i] ?? 0) * a + (bottom[i] ?? 0) * (1 - a)).concat(1);
  };
  const lum = (c: number[]) => {
    const ch = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const background = (el: Element): number[] => {
    const layers: number[][] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c[3] > 0) layers.push(c);
      if (c && c[3] >= 1) break;
    }
    return layers.reverse().reduce((acc, layer) => over(layer, acc), [255, 255, 255, 1]);
  };
  const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
  const hidden = (el: Element) => Boolean(el.closest('.sr-only, [hidden]')) || getComputedStyle(el).visibility === 'hidden';
  const inScroller = (el: Element) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const ox = getComputedStyle(e).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };

  const stage = document.getElementById('stage') as HTMLElement;
  const zoom = Number(getComputedStyle(stage).zoom) || 1;
  const vw = document.documentElement.clientWidth;
  const card = document.getElementById('app') as HTMLElement;
  const cardRect = card.getBoundingClientRect();
  const contentBottom = cardRect.bottom - parseFloat(getComputedStyle(card).paddingBottom) * zoom;
  let bottomBleed = 0;
  /** Text pushed outside an ancestor that clips (overflow hidden), like a chip wider than its card. */
  const clippedBy = (el: Element, r: DOMRect): Element | null => {
    for (let e = el.parentElement; e && e !== card; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      if (s.overflowX === 'auto' || s.overflowX === 'scroll') return null;
      const a = e.getBoundingClientRect();
      if (r.right > a.right + 1 || r.left < a.left - 1 || r.bottom > a.bottom + 1 || r.top < a.top - 1) return e;
    }
    return null;
  };
  const offscreen: string[] = [];
  const lowContrast: string[] = [];
  const clippedText: string[] = [];
  let textChecked = 0;
  let minContrast = Infinity;
  for (const el of Array.from(document.querySelectorAll('#app *'))) {
    if (hidden(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if ((r.right > vw + 1 || r.left < -1) && !inScroller(el)) offscreen.push(describe(el));
    if (!inScroller(el)) bottomBleed = Math.max(bottomBleed, r.bottom - contentBottom);
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim());
    if (!ownText) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = background(el);
    const value = ratio(over(fg, bg), bg);
    textChecked++;
    minContrast = Math.min(minContrast, value);
    if (value < 4.5) lowContrast.push(`${describe(el)} ${value.toFixed(2)} (${cs.color} on rgb(${bg.slice(0, 3).map(Math.round).join(',')}))`);
    // Text cut without an ellipsis: wider than its box and not clamped.
    const clamped = cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '';
    if (!clamped && cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis') clippedText.push(describe(el));
    const clipper = clippedBy(el, r);
    if (clipper) clippedText.push(`${describe(el)} clipped by ${describe(clipper)}`);
  }
  const controls = Array.from(document.querySelectorAll<HTMLElement>('#app button, #app a[href], #app [role="button"], #app input, #app select'));
  const smallTargets: string[] = [];
  const unnamedControls: string[] = [];
  for (const c of controls) {
    if (hidden(c)) continue;
    const r = c.getBoundingClientRect();
    // Rendered size, and size in authoring units (before the root zoom): both at least 48.
    if (r.width < 48 || r.height < 48 || r.width / zoom < 47.5 || r.height / zoom < 47.5) smallTargets.push(`${describe(c)} ${Math.round(r.width)}x${Math.round(r.height)} zoom ${zoom}`);
    const name = (c.getAttribute('aria-label') ?? c.textContent ?? '').trim();
    if (!name) unnamedControls.push(describe(c));
  }
  let decisionSpill = 0;
  for (const d of Array.from(document.querySelectorAll<HTMLElement>('#app .decision'))) {
    const ds = getComputedStyle(d);
    const bottom = d.getBoundingClientRect().bottom - (parseFloat(ds.paddingBottom) + parseFloat(ds.borderBottomWidth)) * zoom;
    for (const el of Array.from(d.querySelectorAll('*'))) {
      if (hidden(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      decisionSpill = Math.max(decisionSpill, r.bottom - bottom);
    }
  }
  return {
    zoom,
    overflowX: (document.scrollingElement?.scrollWidth ?? 0) - vw,
    offscreen,
    smallTargets,
    unnamedControls,
    lowContrast,
    textChecked,
    minContrast: Number.isFinite(minContrast) ? Number(minContrast.toFixed(2)) : 0,
    contentOverflowY: card.scrollHeight - card.clientHeight,
    bottomBleed: Math.max(0, Math.round(bottomBleed * 10) / 10),
    decisionSpill: Math.max(0, Math.round(decisionSpill * 10) / 10),
    cardScrollTop: card.scrollTop,
    decisionFit: Number(document.querySelector<HTMLElement>('#app .decision')?.dataset.fit ?? 0),
    clippedText,
  };
}

export async function audit(frame: Frame): Promise<Audit> {
  return frame.evaluate(auditInPage);
}

export interface Reach {
  frameHeight: number;
  /** The card's own height: it stops at the host's cap and scrolls inside. */
  cardHeight: number;
  cardScrolls: boolean;
  controls: number;
  /** Controls that cannot be scrolled into view and hit at their center. */
  unreachable: string[];
  /** With nothing scrolled: is the pinned action bar fully on screen? null when the screen has none. */
  pinnedVisible: boolean | null;
  /** Must be 0: the card is the only scroller, so a swipe cannot drag the page. */
  pageOverflow: number;
}

/** Runs inside the view frame: each control is scrolled into view the way a finger would, then hit tested. */
export function reachInPage(): Reach {
  const card = document.getElementById('app') as HTMLElement;
  const vh = window.innerHeight;
  const describe = (el: Element) => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
  const visible = (el: HTMLElement) => !el.closest('[hidden], .sr-only') && el.getClientRects().length > 0;
  const top = () => {
    card.scrollTop = 0;
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  };
  top();
  const bar = document.querySelector('.action-bar');
  let pinnedVisible: boolean | null = null;
  if (bar) {
    const r = bar.getBoundingClientRect();
    pinnedVisible = r.top >= -1 && r.bottom <= vh + 1;
  }
  const controls = Array.from(document.querySelectorAll<HTMLElement>('#app button, #app [tabindex="0"]')).filter(visible);
  const unreachable: string[] = [];
  for (const c of controls) {
    c.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = c.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(hit === c || c.contains(hit))) unreachable.push(`${describe(c)} center ${Math.round(r.top + r.height / 2)} of ${vh}`);
  }
  top();
  const page = document.scrollingElement as HTMLElement;
  return {
    frameHeight: vh,
    cardHeight: card.offsetHeight,
    cardScrolls: card.scrollHeight > card.clientHeight + 1,
    controls: controls.length,
    unreachable,
    pinnedVisible,
    pageOverflow: page.scrollHeight - vh,
  };
}

export async function reach(frame: Frame): Promise<Reach> {
  return frame.evaluate(reachInPage);
}
