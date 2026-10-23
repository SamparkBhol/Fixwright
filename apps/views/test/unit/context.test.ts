import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { describe, expect, test } from 'vitest';
import { BASE_CANVAS, DEVICE_CLASS_KEY, NOW_KEY, anchorClock, anchoredNow, deriveDeviceClass, resolveSurface, rootScale, surfaceClasses } from '../../src/ui/context.ts';

const ctx = (w: number, h: number, extra: Record<string, unknown> = {}): McpUiHostContext => ({ containerDimensions: { width: w, height: h }, ...extra });

describe('resolveSurface', () => {
  test('Echo Show 8 and 15 class: one root zoom of 1.667 over the 768x480 canvas', () => {
    const s = resolveSurface(ctx(1280, 800, { [DEVICE_CLASS_KEY]: 'large', theme: 'dark' }), { width: 1280, height: 800 });
    expect(s).toMatchObject({ deviceClass: 'large', classSource: 'host', orientation: 'landscape', theme: 'dark' });
    expect(s.scale).toBeCloseTo(1280 / BASE_CANVAS.width, 3);
    expect(s.canvasWidth).toBeCloseTo(768, 0);
    expect(s.canvasHeight).toBeCloseTo(480, 0);
  });

  test('small display (960x480) keeps authored size and gets a wider canvas', () => {
    const s = resolveSurface(ctx(960, 480, { [DEVICE_CLASS_KEY]: 'small' }), { width: 960, height: 480 });
    expect(s).toMatchObject({ deviceClass: 'small', scale: 1, canvasWidth: 960, canvasHeight: 480, orientation: 'landscape' });
  });

  test('phone is portrait at scale 1', () => {
    const s = resolveSurface(ctx(390, 844, { [DEVICE_CLASS_KEY]: 'phone' }), { width: 390, height: 844 });
    expect(s).toMatchObject({ deviceClass: 'phone', scale: 1, orientation: 'portrait', canvasWidth: 390 });
  });

  test('deviceClass is authoritative over the size', () => {
    const s = resolveSurface(ctx(1280, 800, { [DEVICE_CLASS_KEY]: 'phone' }), { width: 1280, height: 800 });
    expect(s.deviceClass).toBe('phone');
    expect(s.classSource).toBe('host');
  });

  test('falls back to containerDimensions when the host sends no class', () => {
    expect(resolveSurface(ctx(1280, 800), { width: 0, height: 0 })).toMatchObject({ deviceClass: 'large', classSource: 'derived' });
    expect(resolveSurface(ctx(960, 480), { width: 0, height: 0 })).toMatchObject({ deviceClass: 'small', classSource: 'derived' });
    expect(resolveSurface(ctx(390, 844), { width: 0, height: 0 })).toMatchObject({ deviceClass: 'phone', classSource: 'derived' });
    expect(resolveSurface(ctx(1280, 800, { [DEVICE_CLASS_KEY]: 'tv' }), { width: 0, height: 0 }).classSource).toBe('derived');
  });

  test('a flexible container (maxHeight only) leaves the height to the content and keeps the cap', () => {
    const s = resolveSurface({ containerDimensions: { width: 390, maxHeight: 900 } }, { width: 390, height: 150 });
    expect(s.height).toBeNull();
    expect(s.canvasHeight).toBeNull();
    expect(s).toMatchObject({ maxHeight: 900, canvasMaxHeight: 900 });
    expect(surfaceClasses(s)).toContain('h-flex');
  });

  test("apps/host's phone ({width: 358, maxHeight: 480}) is a capped portrait phone", () => {
    const s = resolveSurface({ containerDimensions: { width: 358, maxHeight: 480 }, platform: 'mobile', [DEVICE_CLASS_KEY]: 'phone' }, { width: 358, height: 440 });
    expect(s).toMatchObject({ deviceClass: 'phone', orientation: 'portrait', scale: 1, width: 358, height: null, maxHeight: 480, canvasMaxHeight: 480 });
    expect(resolveSurface({ containerDimensions: { width: 358, maxHeight: 480 } }, { width: 358, height: 440 }).deviceClass).toBe('phone');
  });

  test('a capped wide container keeps its zoom and converts the cap to canvas px', () => {
    const s = resolveSurface({ containerDimensions: { width: 1280, maxHeight: 800 }, [DEVICE_CLASS_KEY]: 'large' }, { width: 1280, height: 300 });
    expect(s.scale).toBeCloseTo(1.667, 3);
    expect(s.canvasMaxHeight).toBeCloseTo(480, 0);
  });

  test('fixed containers and a zero cap carry no cap', () => {
    expect(resolveSurface(ctx(1280, 800), { width: 1, height: 1 }).maxHeight).toBeNull();
    expect(resolveSurface({ containerDimensions: { maxHeight: 0 } }, { width: 480, height: 480 })).toMatchObject({ height: null, maxHeight: null });
  });

  test('without any context it uses the frame viewport and safe defaults', () => {
    const s = resolveSurface(undefined, { width: 1280, height: 800 });
    expect(s).toMatchObject({ deviceClass: 'large', displayMode: 'inline', canFullscreen: false, theme: null, locale: 'en-US', timeZone: undefined });
  });

  test('display mode, fullscreen availability, locale and zone come from the host', () => {
    const s = resolveSurface(ctx(1280, 800, { displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'], locale: 'en-IN', timeZone: 'Asia/Kolkata' }), { width: 1, height: 1 });
    expect(s).toMatchObject({ displayMode: 'fullscreen', canFullscreen: true, locale: 'en-IN', timeZone: 'Asia/Kolkata' });
    expect(surfaceClasses(s)).toEqual(['dc-large', 'mode-fullscreen', 'orient-landscape', 'h-fixed']);
  });
});

describe('helpers', () => {
  test('deriveDeviceClass', () => {
    expect(deriveDeviceClass(1280, 800)).toBe('large');
    expect(deriveDeviceClass(1024, 600)).toBe('small');
    expect(deriveDeviceClass(800, 1280)).toBe('phone');
    expect(deriveDeviceClass(1280, 800, 'mobile')).toBe('phone');
  });

  test('rootScale never shrinks below the authored size', () => {
    expect(rootScale('small', 480, 320)).toBe(1);
    expect(rootScale('large', 1920, 1200)).toBeCloseTo(2.5, 3);
    expect(rootScale('voice', 1280, 800)).toBe(1);
  });

  test('the host clock moves between host updates, and a new value moves the anchor', () => {
    const at = Date.parse('2026-10-16T14:00:00.000Z');
    const a = anchorClock(null, { [NOW_KEY]: '2026-10-16T14:00:00.000Z' }, 1_000);
    expect(anchoredNow(a, 1_000)).toBe(at);
    expect(anchoredNow(a, 61_000)).toBe(at + 60_000);
    expect(anchorClock(a, { [NOW_KEY]: '2026-10-16T14:00:00.000Z' }, 30_000)).toBe(a);
    const b = anchorClock(a, { [NOW_KEY]: '2026-10-17T14:00:00.000Z' }, 70_000);
    expect(anchoredNow(b, 70_500)).toBe(at + 86_400_000 + 500);
    expect(anchoredNow(anchorClock(b, {}, 80_000), 80_000)).toBe(80_000);
    expect(anchorClock(null, { [NOW_KEY]: 'tomorrow' }, 5)).toBeNull();
  });
});
