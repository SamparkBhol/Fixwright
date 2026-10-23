// Raw Home Assistant shaped rows map to HouseEvents with the right kind and context; household time
// converts to UTC correctly, including across daylight saving changes.

import { describe, expect, it } from 'vitest';
import {
  countDrops,
  lastLocalOccurrence,
  localClock,
  localDayKey,
  parseLocal,
  sortRows,
  toHouseEvents,
  toMs,
  type LogRow,
} from '../src/index.ts';

const rows: LogRow[] = [
  { type: 'automation_triggered', when: '2026-10-15T13:00:00.000Z', entity_id: 'automation.morning', name: 'Morning', source: 'time pattern 06:00', context: { id: 'c1' } },
  { type: 'call_service', when: '2026-10-15T13:00:00.020Z', domain: 'light', service: 'turn_on', entity_ids: ['light.a', 'light.b'], context: { id: 'c1' } },
  { type: 'state', when: '2026-10-15T13:00:00.060Z', entity_id: 'light.a', state: 'on', old_state: 'off', context: { id: 'c1' } },
  { type: 'call_service', when: '2026-10-15T13:05:00.000Z', domain: 'light', service: 'turn_off', entity_ids: ['light.a'], context: { id: 'c1' } },
  { type: 'state', when: '2026-10-15T13:05:00.040Z', entity_id: 'light.a', state: 'off', old_state: 'on', context: { id: 'c1' } },
  { type: 'call_service', when: '2026-10-15T14:00:00.000Z', domain: 'switch', service: 'toggle', entity_ids: ['switch.p'], context: { id: 'c2', user_id: 'user_1' } },
  { type: 'state', when: '2026-10-15T14:00:00.040Z', entity_id: 'switch.p', state: 'on', old_state: 'off', context: { id: 'c2', user_id: 'user_1' } },
  { type: 'state', when: '2026-10-15T10:11:58.100Z', entity_id: 'light.c', state: 'unavailable', old_state: 'off' },
  { type: 'state', when: '2026-10-15T10:12:00.400Z', entity_id: 'light.c', state: 'on', old_state: 'unavailable', context: { id: 'c3' } },
  { type: 'integration', when: '2026-10-15T15:00:00.000Z', integration: 'hue', state: 'setup_error', old_state: 'loaded', reason: 'invalid_auth' },
  { type: 'registry', when: '2026-10-15T15:01:00.000Z', action: 'remove', entity_id: 'light.old' },
  { type: 'device_event', when: '2026-10-15T10:12:00.300Z', entity_id: 'light.c', event: 'boot_reason', data: { reason: 'PowerOnReboot' } },
];

describe('toHouseEvents', () => {
  const events = toHouseEvents(rows);

  it('sorts by time and keeps seq 0 for the ledger', () => {
    const ts = events.map((e) => Date.parse(e.ts));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(events.every((e) => e.seq === 0 && e.source === 'home')).toBe(true);
  });

  it('splits a multi-target service call into one event per entity', () => {
    const calls = events.filter((e) => e.kind === 'service_call' && e.context?.service === 'light.turn_on');
    expect(calls.map((e) => e.entityId)).toEqual(['light.a', 'light.b']);
  });

  it('traces a state change to the automation that caused it, with the right service for each step', () => {
    const changes = events.filter((e) => e.entityId === 'light.a' && e.kind === 'state');
    expect(changes.map((e) => e.context)).toEqual([
      { eventType: 'automation_triggered', automationId: 'automation.morning', service: 'light.turn_on' },
      { eventType: 'automation_triggered', automationId: 'automation.morning', service: 'light.turn_off' },
    ]);
  });

  it('traces a state change to the user who called the service', () => {
    expect(events.find((e) => e.entityId === 'switch.p' && e.kind === 'state')?.context).toEqual({ eventType: 'call_service', userId: 'user_1', service: 'switch.toggle' });
  });

  it('marks availability changes and leaves self-started changes without context', () => {
    const c = events.filter((e) => e.entityId === 'light.c' && e.kind === 'availability');
    expect(c.map((e) => [e.from, e.to])).toEqual([
      ['off', 'unavailable'],
      ['unavailable', 'on'],
    ]);
    expect(c.every((e) => e.context === undefined)).toBe(true);
  });

  it('maps integration, registry and device events', () => {
    expect(events.find((e) => e.kind === 'integration')).toMatchObject({ from: 'loaded', to: 'setup_error', data: { integration: 'hue', reason: 'invalid_auth' } });
    expect(events.find((e) => e.kind === 'note')).toMatchObject({ entityId: 'light.old', data: { action: 'remove' }, context: { eventType: 'entity_registry_updated' } });
    expect(events.find((e) => e.kind === 'power')).toMatchObject({ entityId: 'light.c', data: { event: 'boot_reason', reason: 'PowerOnReboot' } });
    expect(events.find((e) => e.kind === 'automation_run')).toMatchObject({ entityId: 'automation.morning', data: { name: 'Morning', trigger: 'time pattern 06:00' } });
  });

  it('counts drops in a window', () => {
    expect(countDrops(rows, 'light.c', Date.parse('2026-10-15T00:00:00Z'), Date.parse('2026-10-16T00:00:00Z'))).toBe(1);
    expect(countDrops(rows, 'light.c', Date.parse('2026-10-15T10:12:00Z'), Date.parse('2026-10-16T00:00:00Z'))).toBe(0);
  });

  it('sortRows is stable for equal times', () => {
    const same: LogRow[] = [
      { type: 'state', when: '2026-01-01T00:00:00.000Z', entity_id: 'a.x', state: '1' },
      { type: 'state', when: '2026-01-01T00:00:00.000Z', entity_id: 'a.x', state: '2' },
    ];
    expect(sortRows(same).map((r) => (r.type === 'state' ? r.state : ''))).toEqual(['1', '2']);
  });
});

describe('household time', () => {
  const LA = 'America/Los_Angeles';
  it('converts local wall clock to UTC in summer and winter', () => {
    expect(new Date(parseLocal('2026-10-15T15:00:00', LA)).toISOString()).toBe('2026-10-15T22:00:00.000Z');
    expect(new Date(parseLocal('2026-12-15T15:00:00', LA)).toISOString()).toBe('2026-12-15T23:00:00.000Z');
    expect(new Date(parseLocal('2026-10-15T15:00:00', 'Asia/Kolkata')).toISOString()).toBe('2026-10-15T09:30:00.000Z');
  });

  it('handles the spring-forward gap and the fall-back hour', () => {
    expect(localClock(parseLocal('2026-03-08T02:30:00', LA), LA)).toBe('03:30:00');
    expect(new Date(parseLocal('2026-11-01T01:30:00', LA)).toISOString()).toBe('2026-11-01T08:30:00.000Z');
    expect(new Date(parseLocal('2026-11-01T03:00:00', LA)).toISOString()).toBe('2026-11-01T11:00:00.000Z');
  });

  it('finds the last occurrence of a wall clock time', () => {
    const now = parseLocal('2026-10-15T15:00:00', LA);
    expect(localClock(lastLocalOccurrence(now, '03:11:58', LA), LA)).toBe('03:11:58');
    expect(localDayKey(lastLocalOccurrence(now, '03:11:58', LA), LA)).toBe('2026-10-15');
    expect(localDayKey(lastLocalOccurrence(now, '18:00:00', LA), LA)).toBe('2026-10-14');
  });

  it('accepts ISO instants, local strings and epoch ms', () => {
    expect(toMs('2026-10-15T22:00:00Z', LA)).toBe(Date.parse('2026-10-15T22:00:00Z'));
    expect(toMs('2026-10-15T15:00:00-07:00', LA)).toBe(Date.parse('2026-10-15T22:00:00Z'));
    expect(toMs('2026-10-15T15:00:00', LA)).toBe(Date.parse('2026-10-15T22:00:00Z'));
    expect(toMs(1, LA)).toBe(1);
    expect(() => toMs('tomorrow', LA)).toThrowError(/local date time/);
  });
});
