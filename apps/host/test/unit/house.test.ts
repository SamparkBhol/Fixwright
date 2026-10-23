// The house plan and its moments, against the house recorded in test/mock/house.json and the protocol's
// golden path fixtures.

import { describe, expect, it } from 'vitest';
import diagnoseFx from '@fixwright/protocol/fixtures/diagnose.json' with { type: 'json' };
import explainFx from '@fixwright/protocol/fixtures/explain_event.json' with { type: 'json' };
import houseFx from '../mock/house.json' with { type: 'json' };
import { FLASH_MS, clockWords, flashMoment, flashProbe, morningMoment, readHouse, restoreMoment, statesAt, wallAt, wallCueAt, type HouseRoom } from '../../src/house.ts';
import { houseTimeLabel } from '../../src/ui/stage.ts';

const TZ = 'America/Los_Angeles';
const flashAt = Date.parse(diagnoseFx.probes.find((p) => p.probe_id === 'flash_test')?.at ?? '');
const powerBack = Date.parse(explainFx.timeline[1]?.ts ?? '');
const iso = (ms: number): string => new Date(ms).toISOString();

/** The recorded house as /demo/state would list it, with the flash's switches when `flashed`. */
function stateBody(flashed: boolean): unknown {
  const flash: Record<string, number[]> = houseFx.flash;
  const restore: Record<string, number[]> = houseFx.restore;
  return {
    clock: { simulated: true, tz: TZ, note: 'Simulated clock.' },
    entities: [
      ...houseFx.entities.map((e) => ({
        ...e,
        physical: {
          recentActuations: [...(restore[e.entity_id] ?? []).map((t) => powerBack + t), ...(flashed ? (flash[e.entity_id] ?? []).map((t) => flashAt + t) : [])].sort((a, b) => a - b).map(iso),
        },
      })),
      { entity_id: 'binary_sensor.hall_motion', name: 'Hall Motion Sensor', domain: 'binary_sensor', area: 'hallway', state: 'off' },
      { entity_id: 'light.attic', name: 'Attic', domain: 'light', area: 'attic', state: 'on' },
      { entity_id: 'light.porch_old', name: 'Porch', domain: 'light', area: 'hallway', state: 'on', disabled: true },
    ],
  };
}

const roomsOf = (flashed: boolean): HouseRoom[] => readHouse(stateBody(flashed)).rooms ?? [];

describe('house plan', () => {
  it('draws the known rooms plus any new area in the data, one dot per light, switch or fan, and skips sensors and disabled entities', () => {
    const { rooms, clock } = readHouse(stateBody(false));
    expect(rooms?.map((r) => r.name)).toEqual(['Garage', 'Kitchen', 'Hallway', 'Living room', 'Office', 'Bedroom', 'Attic']);
    expect(rooms?.flatMap((r) => r.dots).length).toBe(houseFx.entities.length + 1);
    expect(rooms?.find((r) => r.id === 'attic')?.dots.map((d) => d.entityId)).toEqual(['light.attic']);
    const hallway = rooms?.find((r) => r.id === 'hallway')?.dots.map((d) => [d.entityId, d.state]);
    expect(hallway).toContainEqual(['light.hallway_lamp', 'unavailable']);
    expect(hallway?.some(([id]) => id === 'binary_sensor.hall_motion' || id === 'light.porch_old')).toBe(false);
    expect(clock).toEqual({ simulated: true, tz: TZ, note: 'Simulated clock.' });
  });

  it('reads a server without a house list or clock as nothing known', () => {
    expect(readHouse({ now: '2026-10-15T22:00:00.000Z' })).toEqual({ rooms: null, clock: null });
    expect(readHouse(null)).toEqual({ rooms: null, clock: null });
  });

  it('turns the wall to night from 22:00 to 06:59 house time', () => {
    expect(wallAt(Date.parse('2026-10-15T22:00:00.000Z'), TZ)).toBe('day');
    expect(wallAt(Date.parse('2026-10-16T04:59:00.000Z'), TZ)).toBe('day');
    expect(wallAt(Date.parse('2026-10-16T05:00:00.000Z'), TZ)).toBe('night');
    expect(wallAt(Date.parse('2026-10-16T13:59:00.000Z'), TZ)).toBe('night');
    expect(wallAt(Date.parse('2026-10-16T14:00:00.000Z'), TZ)).toBe('day');
    expect(clockWords(Date.parse('2026-10-15T10:12:00.000Z'), TZ)).toBe('3:12 AM');
    expect(houseTimeLabel(Date.parse('2026-10-15T22:00:00.000Z'), TZ, true)).toBe('House time 3:00 PM, simulated');
    expect(houseTimeLabel(Date.parse('2026-10-15T22:00:00.000Z'), TZ, false)).toBe('House time 3:00 PM');
  });
});

describe('the flash', () => {
  it('blinks the lamp that really switched, twice, in the rhythm of its logged switches', () => {
    const m = flashMoment(diagnoseFx, roomsOf(true));
    expect(m?.devices).toEqual(['light.hallway_lamp_2']);
    expect(m?.frames.map((f) => f.state)).toEqual(['on', 'off', 'on', 'off']);
    const offsets = houseFx.flash['light.hallway_lamp_2'];
    const span = (offsets.at(-1) ?? 0) - (offsets[0] ?? 0);
    expect(m?.spanMs).toBe(span);
    expect(m?.frames.map((f) => f.at)).toEqual(offsets.map((t) => Math.round(((t - (offsets[0] ?? 0)) / span) * FLASH_MS)));
    // The line states what was logged; the words about the slower replay are said only while it moves.
    expect(m?.line).toBe(`The online Hallway Lamp switched 4 times in ${span} ms.`);
    expect(m?.played).toBe('Shown slower, in the same rhythm.');
  });

  it('plays nothing when no switch was logged, and says so when the flash did not answer', () => {
    expect(flashMoment(diagnoseFx, roomsOf(false))).toBeNull();
    const failed = { ...diagnoseFx, probes: diagnoseFx.probes.map((p) => (p.probe_id === 'flash_test' ? { ...p, outcome: 'fail' } : p)) };
    expect(flashMoment(failed, roomsOf(false))?.line).toBe('Fixwright tried to flash the Hallway Lamp. Nothing switched.');
    expect(flashProbe({ probes: [] })).toBeNull();
  });
});

describe('the 3 a.m. restore', () => {
  it('lights the devices that came on, in logged order and at logged offsets, with the wall at night', () => {
    const m = restoreMoment(explainFx, roomsOf(false), TZ, 'day');
    const restore: Record<string, number[]> = houseFx.restore;
    // Devices that were already on went dark at the cut and came back; the plan replays the ones that came on.
    const cameOn = Object.entries(restore)
      .filter(([, t]) => t.every((x) => x >= 0))
      .sort((a, b) => (a[1][0] ?? 0) - (b[1][0] ?? 0))
      .map(([id]) => id);
    expect(m?.devices).toEqual(cameOn);
    expect(m?.devices.length).toBe(14);
    const lit = m?.frames.filter((f) => f.state === 'on' && cameOn.includes(f.entityId)) ?? [];
    expect(lit.map((f) => f.entityId)).toEqual(cameOn);
    const first = lit[0]?.at ?? 0;
    expect(lit.map((f) => f.at - first)).toEqual(cameOn.map((id) => (restore[id]?.[0] ?? 0) - (restore[cameOn[0] as string]?.[0] ?? 0)));
    expect(m?.wall[0]).toEqual({ at: 0, wall: 'night' });
    expect(m?.wall.at(-1)?.wall).toBe('day');
    expect(m?.line).toBe('At 3:12 AM the power came back and the house restarted.');
    expect(m?.played).toBe('Replayed in the order they were logged.');
    // While it plays, the stage label shows the time being replayed, not the house time of day.
    expect(m?.clockMs).toBe(powerBack);
  });

  it('shows every device on the cut circuit offline at the cut, then on as it came back', () => {
    const m = restoreMoment(explainFx, roomsOf(false), TZ, 'day');
    if (!m) throw new Error('no moment');
    const firstOn = Math.min(...m.frames.filter((f) => f.state === 'on').map((f) => f.at));
    const cut = statesAt(m, firstOn - 1);
    expect([...cut.values()].every((s) => s === 'unavailable')).toBe(true);
    // The fourteen that came on, plus the devices that were lit before the cut and went dark with it.
    const litBefore = Object.values(houseFx.restore as Record<string, number[]>).filter((t) => t.some((x) => x < 0)).length;
    expect(litBefore).toBeGreaterThan(0);
    expect(cut.size).toBe(14 + litBefore);
    expect([...statesAt(m, m.duration).values()].every((s) => s === 'on')).toBe(true);
    expect(wallCueAt(m, 0)).toBe('night');
    expect(wallCueAt(m, m.duration)).toBe('day');
  });

  it('plays nothing for an explanation that is not a power restore', () => {
    expect(restoreMoment({ ...explainFx, verdict: { ...explainFx.verdict, cause_id: 'automation' } }, roomsOf(false), TZ, 'day')).toBeNull();
  });
});

describe('the morning', () => {
  it('moves the wall from night to morning light, then hands back to the house clock', () => {
    const m = morningMoment(Date.parse('2026-10-16T14:00:00.000Z'), TZ);
    expect(m.wall.map((w) => w.wall)).toEqual(['night', 'morning']);
    expect(wallCueAt(m, 0)).toBe('night');
    expect(wallCueAt(m, m.duration)).toBe('morning');
    expect(m.line).toBe('7:00 AM in the house. The overnight check ran and its push landed.');
  });
});
