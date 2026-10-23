// One breakpoint and one root scale per render (guide, Layout and rendering: "Resolve once, at render time").
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';

/** Namespaced, since McpUiHostContext allows extra keys. */
export const DEVICE_CLASS_KEY = 'dev.fixwright/deviceClass';
/** The host's clock, possibly simulated, as an ISO time. */
export const NOW_KEY = 'dev.fixwright/now';

/** The person's words that led here; a finished repair lists the steps for the devices they name first. */
export const FOCUS_KEY = 'dev.fixwright/focus';
/** Clearer labels for devices that share a name, keyed `${plan_id}|${label}`, one per step in step order. */
export const STEP_LABELS_KEY = 'dev.fixwright/stepLabels';
/** Header tag words for a real hub; apps/host sends "Real Home Assistant, demo devices" for its test hub. */
export const HUB_LABEL_KEY = 'dev.fixwright/hubLabel';

export interface StepHints {
  focus: string | null;
  labels: Readonly<Record<string, readonly string[]>>;
  hubLabel?: string | null;
}

export const NO_HINTS: StepHints = { focus: null, labels: {} };

const MAX_FOCUS = 300;
const MAX_LABEL_KEYS = 50;
const MAX_LABEL = 240;
const MAX_HUB_LABEL = 48;

/** Any host may send anything under these keys, so every value is checked and capped. */
export function readHints(ctx: McpUiHostContext | undefined): StepHints {
  const rawFocus = ctx?.[FOCUS_KEY];
  const focus = typeof rawFocus === 'string' && rawFocus.trim() ? rawFocus.trim().slice(0, MAX_FOCUS) : null;
  const rawLabels = ctx?.[STEP_LABELS_KEY];
  const labels: Record<string, string[]> = {};
  if (rawLabels && typeof rawLabels === 'object' && !Array.isArray(rawLabels)) {
    for (const [key, value] of Object.entries(rawLabels).slice(0, MAX_LABEL_KEYS)) {
      if (key.length > MAX_LABEL * 2 || !Array.isArray(value)) continue;
      const list = value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_LABEL);
      if (list.length > 0) labels[key] = list;
    }
  }
  const rawHub = ctx?.[HUB_LABEL_KEY];
  const hubLabel = typeof rawHub === 'string' && rawHub.trim() ? rawHub.trim().slice(0, MAX_HUB_LABEL) : null;
  return { focus, labels, ...(hubLabel ? { hubLabel } : {}) };
}

/** Visual foundations: author at 768x480; Echo Show 8 and 15 (1280x800) apply zoom 1.667. */
export const BASE_CANVAS = { width: 768, height: 480 } as const;

export const DEVICE_CLASSES = ['large', 'small', 'phone', 'voice'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];
export type DisplayMode = 'inline' | 'fullscreen' | 'pip';
export type Theme = 'light' | 'dark';

export interface Viewport {
  width: number;
  height: number;
}

export interface Surface {
  deviceClass: DeviceClass;
  classSource: 'host' | 'derived';
  orientation: 'landscape' | 'portrait';
  scale: number;
  /** CSS px of the frame; height is null when the host lets the view grow. */
  width: number;
  height: number | null;
  maxHeight: number | null;
  /** Authoring canvas after the zoom: canvasWidth * scale == width. */
  canvasWidth: number;
  canvasHeight: number | null;
  canvasMaxHeight: number | null;
  displayMode: DisplayMode;
  canFullscreen: boolean;
  theme: Theme | null;
  locale: string;
  timeZone: string | undefined;
  insets: { top: number; right: number; bottom: number; left: number };
}

export function isDeviceClass(value: unknown): value is DeviceClass {
  return typeof value === 'string' && (DEVICE_CLASSES as readonly string[]).includes(value);
}

function positive(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

// maxHeight alone means the host sizes the frame to the content up to that cap (a phone transcript), so the
// height stays open and the view scrolls inside itself past the cap.
export function containerSize(ctx: McpUiHostContext | undefined, viewport: Viewport): { width: number; height: number | null; maxHeight: number | null } {
  const dims = (ctx?.containerDimensions ?? {}) as { width?: unknown; maxWidth?: unknown; height?: unknown; maxHeight?: unknown };
  const width = positive(dims.width) ?? positive(viewport.width) ?? positive(dims.maxWidth) ?? BASE_CANVAS.width;
  const fixedHeight = positive(dims.height);
  if (fixedHeight !== undefined) return { width, height: fixedHeight, maxHeight: null };
  if (dims.maxHeight !== undefined) return { width, height: null, maxHeight: positive(dims.maxHeight) ?? null };
  return { width, height: positive(viewport.height) ?? null, maxHeight: null };
}

/** A guess for hosts that omit dev.fixwright/deviceClass. */
export function deriveDeviceClass(width: number, height: number | null, platform?: string): DeviceClass {
  const portrait = height !== null ? height > width : width < 600;
  if (platform === 'mobile' || portrait || width < 600) return 'phone';
  if (width >= 1200 && (height === null || height >= 720)) return 'large';
  return 'small';
}

/** One root scale per surface: fit the 768x480 canvas, never shrink below authored size. */
export function rootScale(deviceClass: DeviceClass, width: number, height: number | null): number {
  if (deviceClass === 'phone' || deviceClass === 'voice') return 1;
  const byWidth = width / BASE_CANVAS.width;
  const fit = height === null ? byWidth : Math.min(byWidth, height / BASE_CANVAS.height);
  return Math.max(1, Math.round(fit * 1000) / 1000);
}

export function resolveSurface(ctx: McpUiHostContext | undefined, viewport: Viewport): Surface {
  const { width, height, maxHeight } = containerSize(ctx, viewport);
  const hinted = ctx?.[DEVICE_CLASS_KEY];
  const classSource = isDeviceClass(hinted) ? 'host' : 'derived';
  const deviceClass = isDeviceClass(hinted) ? hinted : deriveDeviceClass(width, height, ctx?.platform);
  const scale = rootScale(deviceClass, width, height);
  const portrait = deviceClass === 'phone' || (height !== null && height > width);
  const mode = ctx?.displayMode;
  const insets = ctx?.safeAreaInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    deviceClass,
    classSource,
    orientation: portrait ? 'portrait' : 'landscape',
    scale,
    width,
    height,
    maxHeight,
    canvasWidth: Math.floor((width / scale) * 100) / 100,
    canvasHeight: height === null ? null : Math.floor((height / scale) * 100) / 100,
    canvasMaxHeight: maxHeight === null ? null : Math.floor((maxHeight / scale) * 100) / 100,
    displayMode: mode === 'fullscreen' || mode === 'pip' ? mode : 'inline',
    canFullscreen: (ctx?.availableDisplayModes ?? []).includes('fullscreen'),
    theme: ctx?.theme === 'light' || ctx?.theme === 'dark' ? ctx.theme : null,
    locale: typeof ctx?.locale === 'string' && ctx.locale ? ctx.locale : 'en-US',
    timeZone: typeof ctx?.timeZone === 'string' && ctx.timeZone ? ctx.timeZone : undefined,
    insets,
  };
}

/** Where the host clock stood when its value arrived, so time can move between host updates. */
export interface ClockAnchor {
  raw: string;
  hostMs: number;
  localMs: number;
}

// apps/host sends dev.fixwright/now in whole seconds, a new value on a jump or sync and once a minute
// otherwise, so the same value again keeps the old anchor.
export function anchorClock(prev: ClockAnchor | null, ctx: McpUiHostContext | undefined, localMs: number): ClockAnchor | null {
  const raw = ctx?.[NOW_KEY];
  if (typeof raw !== 'string') return null;
  const hostMs = Date.parse(raw);
  if (!Number.isFinite(hostMs)) return null;
  return prev && prev.raw === raw ? prev : { raw, hostMs, localMs };
}

export function anchoredNow(a: ClockAnchor | null, localMs: number): number {
  return a ? a.hostMs + Math.max(0, localMs - a.localMs) : localMs;
}

/** Inline landscape of fixed height: laid out to fit the canvas (steps fold, the decision fits), never scrolls. */
export function fitsCanvas(s: Pick<Surface, 'displayMode' | 'orientation' | 'height'>): boolean {
  return s.displayMode !== 'fullscreen' && s.orientation === 'landscape' && s.height !== null;
}

/** Root classes for CSS: one class per dimension, so breakpoints live in one place. */
export function surfaceClasses(s: Surface): string[] {
  return [`dc-${s.deviceClass}`, `mode-${s.displayMode}`, `orient-${s.orientation}`, s.height === null ? 'h-flex' : 'h-fixed'];
}
