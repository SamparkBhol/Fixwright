// The house plan and the wall. The plan is read from /demo/state; the moments it
// replays come from logged times only: a SimHome device's recentActuations are the instants its light or
// output changed, which are the instants of the ledger rows for the same writes (checked against the
// explanation timeline in e2e/golden.e2e.ts). Pure, so every moment is tested against recorded houses.

export type DotState = 'on' | 'off' | 'unavailable';
export type Wall = 'day' | 'night';
export type WallCue = Wall | 'morning';

export interface HouseDot {
  entityId: string;
  name: string;
  state: DotState;
  /** When the device visibly switched, oldest first, in ms. Empty when the hub cannot say (Home Assistant). */
  switched: number[];
}

export interface HouseRoom {
  id: string;
  name: string;
  dots: HouseDot[];
}

export interface HouseClock {
  simulated: boolean;
  tz: string;
  note: string;
}

export interface HouseRead {
  rooms: HouseRoom[] | null;
  clock: HouseClock | null;
}

export interface Frame {
  at: number;
  entityId: string;
  state: DotState;
}

export interface Moment {
  id: number;
  kind: 'flash' | 'restore' | 'morning';
  frames: Frame[];
  wall: Array<{ at: number; wall: WallCue }>;
  /** When the plan goes back to the live house, in ms from the start. */
  duration: number;
  /** What happened, in words. With reduced motion this line is the whole moment. */
  line: string;
  /** Said after the line only while the replay moves, so a still plan never claims motion. */
  played: string;
  /** The house time a replay shows, for the stage label while it plays. */
  clockMs: number | null;
  /** The devices the moment replays, in the order their switches were logged. */
  devices: string[];
  /** From the first logged switch to the last, in house ms. */
  spanMs: number;
}

export type MomentDraft = Omit<Moment, 'id'>;

export const ROOMS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'garage', name: 'Garage' },
  { id: 'kitchen', name: 'Kitchen' },
  { id: 'hallway', name: 'Hallway' },
  { id: 'living_room', name: 'Living room' },
  { id: 'office', name: 'Office' },
  { id: 'bedroom', name: 'Bedroom' },
];

const PLAN_DOMAINS: ReadonlySet<string> = new Set(['light', 'switch', 'fan']);

/** A flash's writes land 15 to 16 ms apart in SimHome time, too fast to see, so the replay stretches them to this. */
export const FLASH_MS = 1800;
const FLASH_HOLD_MS = 700;
/** The flash test's writes come just before its probe row. */
const FLASH_LOOKBACK_MS = 10_000;
/** Lead time for the wall to turn before the first replayed switch. */
const WALL_TURN_MS = 1000;
const RESTORE_HOLD_MS = 1600;
/** A restore longer than this is played faster, keeping the logged order and proportions. */
const RESTORE_MAX_MS = 8000;
/** The restore rows and the switches they caused can differ by a few ms. */
const SLACK_MS = 50;
const MORNING_NIGHT_MS = 1100;
const MORNING_LIGHT_MS = 2600;

export function dotState(state: string): DotState {
  if (state === 'on') return 'on';
  if (state === 'unavailable' || state === 'unknown') return 'unavailable';
  return 'off';
}

/** 07:00 to 21:59 house time is day, 22:00 to 06:59 is night. */
export function wallAt(ms: number, timeZone: string): Wall {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(new Date(ms)));
  return hour >= 7 && hour <= 21 ? 'day' : 'night';
}

/** "3:12 AM", written the way the device, its push and the views write a time. */
export function clockWords(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).replace(/\u202f/g, ' ');
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function switchTimes(physical: unknown): number[] {
  const list = (physical as { recentActuations?: unknown } | null | undefined)?.recentActuations;
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => (typeof t === 'string' ? Date.parse(t) : Number.NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

export function readHouse(body: unknown): HouseRead {
  const o = (body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o['entities']) ? (o['entities'] as unknown[]) : null;
  let rooms: HouseRoom[] | null = null;
  if (list) {
    const byArea = new Map<string, HouseDot[]>(ROOMS.map((r) => [r.id, []]));
    for (const raw of list) {
      const e = (raw ?? {}) as Record<string, unknown>;
      const id = str(e['entity_id']);
      const domain = str(e['domain']) ?? (id ? id.split('.')[0] : null);
      const area = str(e['area']);
      if (!id || !domain || !PLAN_DOMAINS.has(domain) || !area || e['disabled'] === true) continue;
      byArea.get(area)?.push({ entityId: id, name: str(e['name']) ?? id, state: dotState(str(e['state']) ?? ''), switched: switchTimes(e['physical']) });
    }
    rooms = ROOMS.map((r) => ({ id: r.id, name: r.name, dots: byArea.get(r.id) ?? [] }));
  }
  const c = o['clock'] as Record<string, unknown> | undefined;
  const clock: HouseClock | null =
    c && typeof c === 'object' && typeof c['tz'] === 'string' ? { simulated: c['simulated'] === true, tz: c['tz'], note: str(c['note']) ?? '' } : null;
  return { rooms, clock };
}

const dotsOf = (rooms: readonly HouseRoom[]): HouseDot[] => rooms.flatMap((r) => r.dots);
const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const within = (t: number, from: number, to: number): boolean => t >= from && t <= to;
const flip = (s: DotState): DotState => (s === 'on' ? 'off' : 'on');

interface ProbeLike {
  probe_id?: unknown;
  outcome?: unknown;
  at?: unknown;
}

/** The newest flash test in a diagnose result, keyed so a later answer that repeats it is not replayed. */
export function flashProbe(sc: unknown): { key: string; at: number; answered: boolean; target: string; targetId: string | null } | null {
  const o = (sc ?? {}) as Record<string, unknown>;
  const probes = Array.isArray(o['probes']) ? (o['probes'] as ProbeLike[]) : [];
  const p = [...probes].reverse().find((x) => x?.probe_id === 'flash_test' && typeof x.at === 'string');
  const at = typeof p?.at === 'string' ? Date.parse(p.at) : Number.NaN;
  if (!p || !Number.isFinite(at)) return null;
  const t = (o['target'] ?? {}) as Record<string, unknown>;
  return { key: `${str(o['diagnosis_id']) ?? ''}|${String(p.at)}`, at, answered: p.outcome === 'pass', target: str(t['name']) ?? 'the device', targetId: str(t['entity_id']) };
}

/**
 * The flash test, from the switches logged just before its probe row. The flashed dot is the one that
 * switched, which for a ghost is the online copy, not the entity the person named.
 */
export function flashMoment(sc: unknown, rooms: readonly HouseRoom[] | null): MomentDraft | null {
  const f = flashProbe(sc);
  if (!f || !rooms) return null;
  const inWindow = (d: HouseDot): number[] => d.switched.filter((t) => within(t, f.at - FLASH_LOOKBACK_MS, f.at + SLACK_MS));
  const candidates = dotsOf(rooms)
    .map((d) => ({ d, times: inWindow(d) }))
    .filter((c) => c.times.length >= 2)
    .sort((a, b) => b.times.length - a.times.length || Number(fold(b.d.name) === fold(f.target)) - Number(fold(a.d.name) === fold(f.target)));
  const hit = candidates[0];
  if (!hit) {
    if (f.answered) return null;
    return { kind: 'flash', frames: [], wall: [], duration: 0, line: `Fixwright tried to flash the ${f.target}. Nothing switched.`, played: '', clockMs: null, devices: [], spanMs: 0 };
  }
  const { d, times } = hit;
  const t0 = times[0] as number;
  const span = (times.at(-1) as number) - t0;
  // Each logged switch flips the light, so the state before the first one follows from the live state.
  let state: DotState = times.length % 2 === 0 ? (d.state === 'on' ? 'on' : 'off') : d.state === 'on' ? 'off' : 'on';
  const frames: Frame[] = times.map((t, i) => {
    state = flip(state);
    return { at: span > 0 ? Math.round(((t - t0) / span) * FLASH_MS) : Math.round((i / Math.max(1, times.length - 1)) * FLASH_MS), entityId: d.entityId, state };
  });
  // A ghost's name points at the old copy, so the lamp that really switched is the online one.
  const who = f.targetId !== null && f.targetId !== d.entityId && fold(d.name) === fold(f.target) ? `online ${d.name}` : d.name;
  const line = `The ${who} switched ${times.length} times in ${span} ms.`;
  return { kind: 'flash', frames, wall: [], duration: FLASH_MS + FLASH_HOLD_MS, line, played: 'Shown slower, in the same rhythm.', clockMs: null, devices: [d.entityId], spanMs: span };
}

/** Power out, power back and the last device on, from an explanation of a power restore. */
export function restoreSpan(sc: unknown): { out: number; back: number; end: number } | null {
  const o = (sc ?? {}) as Record<string, unknown>;
  const verdict = (o['verdict'] ?? {}) as Record<string, unknown>;
  if (verdict['cause_id'] !== 'power_restore' || !Array.isArray(o['timeline'])) return null;
  const times = (o['timeline'] as Array<{ ts?: unknown }>)
    .map((t) => (typeof t?.ts === 'string' ? Date.parse(t.ts) : Number.NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  return { out: times[0] as number, back: times[1] as number, end: times.at(-1) as number };
}

const seconds = (ms: number): string => (Math.round(ms / 100) / 10).toString();

/**
 * The 3 a.m. restore: the devices that came on between "Power came back" and the explanation's last row
 * and were dark before the cut, lit in the order and at the offsets their switches were logged. Devices
 * that were lit before the cut go dark when their switch was logged and come back the same way.
 */
export function restoreMoment(sc: unknown, rooms: readonly HouseRoom[] | null, timeZone: string, live: Wall): MomentDraft | null {
  const span = restoreSpan(sc);
  if (!span || !rooms) return null;
  const lit = dotsOf(rooms)
    .map((d) => ({
      d,
      on: d.switched.find((t) => within(t, span.back - SLACK_MS, span.end + SLACK_MS)),
      before: d.switched.some((t) => within(t, span.out - 2_000, span.back - SLACK_MS - 1)),
    }))
    .filter((x): x is { d: HouseDot; on: number; before: boolean } => x.on !== undefined && !x.before)
    .sort((a, b) => a.on - b.on);
  if (lit.length === 0) return null;
  const relit = dotsOf(rooms)
    .map((d) => ({
      d,
      dark: d.switched.find((t) => within(t, span.out - 2_000, span.back - SLACK_MS - 1)),
      on: d.switched.find((t) => within(t, span.back - SLACK_MS, span.end + SLACK_MS)),
    }))
    .filter((x): x is { d: HouseDot; dark: number; on: number | undefined } => x.dark !== undefined);
  const first = lit[0]?.on as number;
  const last = lit.at(-1)?.on as number;
  const length = last - span.out;
  const k = length > RESTORE_MAX_MS ? RESTORE_MAX_MS / length : 1;
  const at = (t: number): number => Math.max(0, WALL_TURN_MS + Math.round((t - span.out) * k));
  const frames: Frame[] = [
    ...lit.map((x) => ({ at: at(span.out), entityId: x.d.entityId, state: 'unavailable' as DotState })),
    ...relit.map((x) => ({ at: at(x.dark), entityId: x.d.entityId, state: 'unavailable' as DotState })),
    ...lit.map((x) => ({ at: at(x.on), entityId: x.d.entityId, state: 'on' as DotState })),
    ...relit.flatMap((x) => (x.on === undefined ? [] : [{ at: at(x.on), entityId: x.d.entityId, state: 'on' as DotState }])),
  ].sort((a, b) => a.at - b.at);
  const end = at(last) + RESTORE_HOLD_MS;
  const line = `At ${clockWords(span.back, timeZone)} the power came back and the house restarted.`;
  return {
    kind: 'restore',
    frames,
    wall: [
      { at: 0, wall: 'night' },
      { at: end, wall: live },
    ],
    duration: end + WALL_TURN_MS,
    line,
    played: 'Replayed in the order they were logged.',
    clockMs: span.back,
    devices: lit.map((x) => x.d.entityId),
    spanMs: last - first,
  };
}

export function morningMoment(nowMs: number, timeZone: string): MomentDraft {
  return {
    kind: 'morning',
    frames: [],
    wall: [
      { at: 0, wall: 'night' },
      { at: MORNING_NIGHT_MS, wall: 'morning' },
    ],
    duration: MORNING_NIGHT_MS + MORNING_LIGHT_MS,
    line: `${clockWords(nowMs, timeZone)} in the house. The overnight check ran and its push landed.`,
    played: '',
    clockMs: null,
    devices: [],
    spanMs: 0,
  };
}

/** The dot states a moment leaves behind at `t` ms, on top of the live house. */
export function statesAt(m: Pick<Moment, 'frames'>, t: number): Map<string, DotState> {
  const out = new Map<string, DotState>();
  for (const f of m.frames) if (f.at <= t) out.set(f.entityId, f.state);
  return out;
}

export function wallCueAt(m: Pick<Moment, 'wall'>, t: number): WallCue | null {
  let cue: WallCue | null = null;
  for (const w of m.wall) if (w.at <= t) cue = w.wall;
  return cue;
}

