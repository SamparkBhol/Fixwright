import { localTime } from '@fixwright/engine';
import { SimHome, type SimSnapshot } from 'homefault';
import { describe, expect, it } from 'vitest';
import { buildTemplate, TEMPLATE_START } from '../../src/household/template-build.ts';
import { clearTemplates, DEMO_TEMPLATE, demoHome, rebasable } from '../../src/household/template.ts';

const TZ = 'America/Los_Angeles';
const OUTAGE = 'power_restore_default_on';

const outageAt = (s: SimSnapshot): number => s.faults[OUTAGE]?.opts['at'] as number;

describe('demo house template', () => {
  it('the committed demo-template.json is what scripts/build-template.ts builds today', async () => {
    const { template } = await buildTemplate();
    expect(JSON.stringify(template)).toBe(JSON.stringify(DEMO_TEMPLATE));
    expect(DEMO_TEMPLATE.start).toBe(TEMPLATE_START);
    expect(DEMO_TEMPLATE.aquarium).toEqual({ entity_id: 'switch.aquarium_filter', name: 'Aquarium Filter' });
  });

  it('a house that starts at 15:00 on a later day is the template moved there, outage still at 3:11 a.m.', async () => {
    clearTemplates();
    const start = Date.parse('2026-10-22T22:00:00.000Z');
    const home = await demoHome(9, TZ, start);
    expect(home.from).toBe('template');
    const snap = JSON.parse(home.json) as SimSnapshot;
    expect(snap.seed).toBe(9);
    expect(snap.nowMs).toBe(start);
    const created = SimHome.create({ seed: 1, tz: TZ, now: start }).snapshot();
    expect(outageAt(snap)).toBe(outageAt(created));
    expect(localTime(outageAt(snap), TZ)).toMatchObject({ day: 22, hour: 3, minute: 11 });
    expect(Object.keys(snap.faults).sort()).toEqual(Object.keys(created.faults).sort());
    expect(Object.keys(snap.entities).sort()).toEqual(Object.keys(created.entities).sort());
    expect((await demoHome(10, TZ, start)).from).toBe('cache');
  });

  it('keeps local times across the end of daylight saving time', () => {
    expect(rebasable(Date.parse('2026-11-05T23:00:00.000Z'), TZ)).toBe(true);
    expect(rebasable(Date.parse('2026-11-05T22:00:00.000Z'), TZ)).toBe(false);
  });

  it('a start at another time of day, or in another time zone, creates its house', async () => {
    clearTemplates();
    const start = Date.parse('2026-10-22T16:30:00.000Z');
    expect(rebasable(start, TZ)).toBe(false);
    expect(rebasable(Date.parse(TEMPLATE_START), 'Europe/Berlin')).toBe(false);
    const home = await demoHome(1, TZ, start);
    expect(home.from).toBe('create');
    expect(home.sim?.snapshot().nowMs).toBe(start);
    expect(home.aquarium).toEqual(DEMO_TEMPLATE.aquarium);
  });
});
