// Every template renders a speakable, plain line with no banned words or long dashes.
// The source has no Node built in modules, ambient clock or randomness, and bundles for a neutral
// platform (workerd and browser conditions) into code that runs a diagnosis.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { manualClock, seededRng, speechProblems } from '@fixwright/protocol';
import { PHRASE_KEYS, phrase, type PhraseKey, type PhraseParams } from '../src/index.ts';
import { buildGoldenHouse, FILTER, NOW, TZ } from './support/golden-house.ts';
import { createFakeAdapter } from './support/fake-adapter.ts';

const SAMPLES: { [K in PhraseKey]: PhraseParams<K> } = {
  dx_passive_summary: { parts: ['your hub is reachable', 'the signal is good', 'the Hue cloud is fine'] },
  dx_ask_flash: { name: 'hallway lamp' },
  dx_ask_flash_click: { name: 'kitchen plug' },
  dx_ask_flash_start: { name: 'bedroom fan' },
  dx_reask_flash: { name: 'hallway lamp' },
  dx_reask_flash_click: { name: 'kitchen plug' },
  dx_recall_flash: { name: 'hallway lamp' },
  dx_recall_click: { name: 'kitchen plug' },
  dx_ask_wall_switch: { noun: 'lamp' },
  dx_ask_plugged_in: { name: 'kitchen plug' },
  dx_reask_power: { name: 'kitchen plug' },
  dx_ask_router: {},
  dx_reask_router: {},
  dx_ask_consent: { name: 'hallway lamp' },
  dx_reask_consent: { name: 'hallway lamp' },
  dx_guided_intro: { name: 'bathroom fan' },
  dx_quiet_declined: {},
  dx_offer_fix: {},
  dx_likely: { cause: 'a weak signal' },
  dx_cant_tell: { causes: ['a power problem', 'a weak signal'] },
  dx_settle_flash: {},
  dx_settle_switch: {},
  dx_settle_router: {},
  dx_settle_generic: {},
  dx_cant_tell_works: {},
  guide_power: { name: 'hallway lamp', check: true },
  guide_battery: { name: 'hall motion sensor', check: false },
  guide_battery_seat: { name: 'hall motion sensor', check: true },
  guide_radio: { name: 'kitchen plug', check: true },
  guide_cloud: { check: true },
  guide_account: { check: true },
  guide_power_on: { name: 'porch light' },
  guide_wifi: { check: true, count: 3 },
  claim_works: { noun: 'lamp' },
  claim_online_answers: { noun: 'lamp' },
  claim_stale: { name: 'Hallway Lamp', date: 'October 3' },
  claim_stale_nodate: { name: 'Hallway Lamp' },
  claim_offline_since: { name: 'hallway lamp', since: 'since October 3' },
  claim_switch_off: { name: 'kitchen ceiling' },
  dx_unrelated_fault: { cause: 'an old copy of the device', complaint: 'unexpected_on' },
  claim_battery_low: { name: 'hall motion sensor', pct: 6 },
  claim_no_blink: { name: 'hallway lamp' },
  claim_worked_now: { name: 'kitchen ceiling' },
  claim_answered_now: { name: 'kitchen ceiling' },
  claim_infra_fine: {},
  claim_flaps: { name: 'kitchen plug', count: 9 },
  claim_weak_wifi: { dbm: -82 },
  claim_weak_zigbee: { lqi: 41 },
  claim_hub_down: { hub: 'Zigbee hub' },
  claim_hub_devices: { count: 12 },
  claim_cloud: { brand: 'Ecobee' },
  claim_auth: { brand: 'Hue' },
  claim_power_on: { name: 'porch light' },
  claim_collision: { name: 'Living Room Light', count: 2 },
  claim_collision_online: { count: 2 },
  claim_refs_ok: { name: 'Night Lights' },
  claim_dead_trigger: { name: 'Grow Light Schedule' },
  claim_wifi_peers: { count: 3 },
  claim_router_changed: {},
  ex_power_back: { time: '3:12' },
  ex_restarted: { count: 14, within: 'four seconds' },
  ex_no_automation: {},
  ex_offer_power_fix: { count: 14 },
  ex_automation: { automation: 'Night Lights', what: 'fourteen devices', time: '3:12 a.m.' },
  ex_automation_trigger: { trigger: 'sunset' },
  ex_user: { what: 'the porch light', time: '7:02' },
  ex_unexplained: { what: 'fourteen devices', time: '3:12' },
  ex_own_intro: {},
  ex_own: { verb: 'switched', what: 'the hallway lamp', time: '3:00', purposes: ['to test it', 'to check the fix'] },
  ex_own_label: {},
  ex_not_in_restore: { name: 'kitchen plug', count: 14, time: '3:12 a.m.' },
  ex_in_restore: { name: 'porch light' },
  ex_cant_tell: {},
  ex_settle: {},
  ex_fix_label: { count: 14 },
  ex_tl_out: {},
  ex_tl_back: {},
  ex_tl_no_context: { count: 14 },
  ck_intro: { count: 3 },
  ck_healthy: {},
  ck_more: { count: 2 },
  ck_title_duplicate: { count: 2, noun: 'light', name: 'Living Room Light' },
  ck_title_ghost: { name: 'Hallway Lamp' },
  ck_say_ghost: { name: 'Hallway Lamp' },
  ck_title_flapping: { name: 'Kitchen Plug', count: 9, wifi: true, period: 'today' },
  ck_say_flapping: { name: 'Kitchen Plug', count: 9, wifi: true, period: 'today' },
  ck_title_battery: { name: 'Hall Motion Sensor', pct: 6 },
  ck_say_battery: { name: 'Hall Motion Sensor', pct: 6 },
  ck_title_dead_trigger: { name: 'Grow Light Schedule' },
  ck_title_power_on: { count: 14, name: 'Porch Light' },
  ck_title_integration: { brand: 'Hue', auth: true },
  ck_title_unprotected: { load: 'Aquarium Filter' },
  pl_intro: {},
  pl_confirm: {},
  pl_stale_point: { name: 'Hallway Lamp', noun: 'lamp' },
  pl_stale_retire: { since: 'since October 3' },
  pl_stale_retire_plain: {},
  pl_stale_aliases: { noun: 'lamp', aliases: ['hall light'] },
  pl_power_on: { count: 14, name: 'porch light' },
  pl_cant_change: { names: ['TV plug'] },
  pl_rename: { from: 'Hue group', to: 'Living Room Light Group', name: 'Living Room Light' },
  pl_reload: { hub: 'Zigbee hub' },
  pl_dead_trigger: { name: 'Grow Light Schedule' },
  pl_protected: { load: 'aquarium filter' },
  pl_unsafe: { name: 'garage door opener' },
  st_rename_online: { noun: 'lamp', name: 'Hallway Lamp' },
  st_aliases: { noun: 'lamp', aliases: ['hall light'] },
  st_retire: {},
  st_check: {},
  st_power_on: { name: 'Porch Light' },
  st_rename: { from: 'the Hue group', to: 'Living Room Light Group' },
  st_reload: { hub: 'Zigbee hub' },
  st_automation_off: { name: 'Grow Light Schedule' },
  rb_name: { name: 'Hallway Lamp' },
  rb_retired: {},
  rb_restored: {},
  rb_answers: { times: 2 },
  rb_option: { option: 'previous' },
  rb_loaded: {},
  rb_state: { state: 'off' },
  rb_removed: {},
  rb_aliases: { aliases: ['hall light'] },
  rb_aliases_back: {},
  inv_name: { name: 'Hallway Lamp 2' },
  inv_retire: {},
  inv_aliases: { noun: 'lamp' },
  inv_option: { name: 'Porch Light', option: 'on' },
  inv_automation_on: { name: 'Grow Light Schedule' },
  ap_done_flash: {},
  ap_done: { count: 14 },
  ap_next_check: { count: 1 },
  ap_rolled_back: {},
  ap_failed: {},
  undo_done: { name: 'Hallway Lamp' },
  undo_partial: {},
  undo_settings: { count: 14 },
  undo_nothing: {},
  mc_pass: { name: 'Hallway Lamp', count: 9 },
  mc_pass_quiet: { name: 'Hallway Lamp' },
  mc_fail: { name: 'Hallway Lamp', missed: 2, count: 9 },
  mc_offline: { name: 'Hallway Lamp' },
  mc_answered_offline: { name: 'Hallway Lamp', count: 9, drops: 1 },
  mc_fail_offline: { name: 'Hallway Lamp', missed: 2, count: 9, drops: 3 },
  mc_setting_pass: { count: 14 },
  mc_setting_fail: { changed: 1, count: 14 },
  mc_not_checked: {},
  gc_back: { name: 'hallway lamp' },
  gc_back_all: { count: 4 },
  gc_not_back: { name: 'hallway lamp' },
  gc_not_back_some: { missing: 2, count: 4 },
  gc_flaps_none: { name: 'kitchen plug', period: 'overnight', baseline: 9 },
  gc_flaps_some: { name: 'kitchen plug', count: 3, period: 'since yesterday' },
  gc_cloud_back: { brand: 'Ecobee', name: 'thermostat' },
  gc_cloud_still: { brand: 'Ecobee' },
  gc_link_back: { brand: 'Hue' },
  gc_link_still: { brand: 'Hue' },
  gc_pending: {},
  guard_strip: { loads: ['Aquarium Filter'], alternativeNoun: 'lamp' },
  guard_protected: { load: 'Aquarium Filter' },
  guard_unsafe: {},
  problem: { code: 'hub_unreachable' },
};

const BANNED = /\b(seamless|unlock|journey|leverage|robust|delve|elevate|empower|cutting edge|game changer)\b|\s-\s/i;
/** Labels and titles are not sentences, so they carry no closing punctuation. */
const LABEL = /^(st_|rb_|inv_|ck_title_|ex_tl_|ex_fix_label|ex_own_label)/;

describe('phrasing templates', () => {
  it('has a sample for every template', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...PHRASE_KEYS].sort());
  });

  it.each(PHRASE_KEYS)('%s is plain, speakable and free of banned words', (key) => {
    const text = phrase(key, SAMPLES[key] as never);
    expect(speechProblems(text)).toEqual([]);
    expect(text).not.toMatch(BANNED);
    expect(text).not.toMatch(/[\u2012\u2013\u2014\u2015]/);
    if (LABEL.test(key)) expect(text).not.toMatch(/[.!?]$/);
    else expect(text).toMatch(/[.!?]$/);
    expect(text).not.toMatch(/\.\./);
  });

  it('renders the golden path lines word for word', () => {
    expect(phrase('dx_ask_flash', { name: 'hallway lamp' })).toBe("I'll flash the hallway lamp twice. Did it blink?");
    expect(`${phrase('claim_works', { noun: 'lamp' })} ${phrase('claim_stale', { name: 'Hallway Lamp', date: 'October 3' })}`).toBe(
      'The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3.',
    );
    expect(phrase('dx_offer_fix', {})).toBe('Want me to fix that?');
    expect(phrase('ap_done_flash', {})).toContain('I switched it on and off, it answered both times');
    expect(phrase('mc_pass', { name: 'Hallway Lamp', count: 9 })).toBe('Hallway lamp answered all 9 commands overnight. Repair confirmed.');
    expect(
      [phrase('ex_power_back', { time: '3:12' }), phrase('ex_restarted', { count: 14, within: 'four seconds' }), phrase('ex_no_automation', {})].join(' '),
    ).toBe('Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired.');
    expect(phrase('ex_offer_power_fix', { count: 14 })).toBe('I can make them remember whether they were on or off. Do it?');
    // Fewer settable devices than restarted ones (the Home Assistant beat), and the plain line otherwise.
    expect(phrase('ex_offer_power_fix', { count: 6, restarted: 9 })).toBe('Six of the nine can remember their last state. I can set those. Do it?');
    expect(phrase('ex_offer_power_fix', { count: 1, restarted: 9 })).toBe('One of the nine can remember its last state. I can set that one. Do it?');
    expect(phrase('ex_offer_power_fix', { count: 9, restarted: 9 })).toBe('I can make them remember whether they were on or off. Do it?');
    for (const line of [phrase('ex_offer_power_fix', { count: 6, restarted: 9 }), phrase('ex_offer_power_fix', { count: 1, restarted: 9 })]) {
      expect(line).not.toMatch(BANNED);
      expect(line).not.toMatch(/[\u2013\u2014;]/);
    }
    expect(phrase('ck_title_duplicate', { count: 2, noun: 'light', name: 'Living Room Light' })).toBe('Two lights answer to Living Room Light');
    expect(phrase('ck_title_battery', { name: 'Hall Motion Sensor', pct: 6 })).toBe('Hall motion sensor battery at 6%');
    expect(phrase('ck_title_flapping', { name: 'Kitchen Plug', count: 9, wifi: true, period: 'today' })).toBe('Kitchen plug dropped off Wi-Fi 9 times today');
    expect(phrase('guard_strip', { loads: ['Aquarium Filter'], alternativeNoun: 'lamp' })).toBe(
      "That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.",
    );
    expect(phrase('pl_stale_point', { name: 'Hallway Lamp', noun: 'lamp' })).toBe('Hallway Lamp will point to the lamp that is online.');
    expect(phrase('pl_stale_retire', { since: 'since October 3' })).toBe('The old copy, offline since October 3, is retired.');
  });

  it('has a line for every status: questions, verdicts, confirmations, refusals and errors', () => {
    expect(phrase('dx_ask_router', {})).toMatch(/\?$/);
    expect(phrase('pl_confirm', {})).toBe('Shall I go ahead?');
    expect(phrase('guard_unsafe', {})).toBe("I don't change locks, garage doors, alarms or cameras.");
    expect(phrase('problem', { code: 'hub_unreachable' })).toBe("I couldn't reach your hub just now. Try again in a minute.");
  });
});

const srcDir = new URL('../src/', import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
const sources = files(srcDir).map((file) => ({ file, text: stripComments(readFileSync(file, 'utf8')) }));

const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/from\s+['"]node:/, 'node: import'],
  [/\brequire\(/, 'require()'],
  [/\bprocess\./, 'process global'],
  [/\bBuffer\b/, 'Buffer'],
  [/\bDate\.now\(/, 'Date.now() (inject a Clock)'],
  [/\bnew Date\(\)/, 'new Date() without a time (inject a Clock)'],
  [/\bMath\.random\(/, 'Math.random() (inject an Rng)'],
  [/\bcrypto\./, 'crypto (inject an Rng)'],
  [/\bfetch\(/, 'fetch (all I/O goes through the adapter)'],
  [/\b(setTimeout|setInterval)\(/, 'timers'],
  [/(?<![.\w])(window|document|globalThis)\./, 'runtime globals'],
  [/\bclass\s+\w+/, 'classes'],
  [/:\s*any\b|<any>|as any\b/, 'any'],
];

describe('engine source purity', () => {
  it('found the sources', () => {
    expect(sources.length).toBeGreaterThan(15);
  });

  it.each(FORBIDDEN)('no %s', (pattern, what) => {
    const hits = sources.filter((s) => pattern.test(s.text)).map((s) => s.file);
    expect(hits, `${what} in ${hits.join(', ')}`).toEqual([]);
  });

  it('imports nothing outside the package but @fixwright/protocol', () => {
    const external = new Set<string>();
    for (const { text } of sources) for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) if (!m[1]?.startsWith('.')) external.add(m[1] ?? '');
    expect([...external]).toEqual(['@fixwright/protocol']);
  });

  it('bundles for workerd and the browser and the bundle runs a diagnosis', async () => {
    const result = await build({
      entryPoints: [join(srcDir, 'index.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      conditions: ['workerd', 'worker', 'browser'],
      metafile: true,
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.metafile.inputs).some((i) => i.startsWith('node:'))).toBe(false);
    const code = result.outputFiles[0]?.text ?? '';
    const bundle = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as typeof import('../src/index.ts');
    const clock = manualClock(NOW);
    const deps = {
      adapter: createFakeAdapter(buildGoldenHouse(), clock),
      ledger: bundle.createMemoryLedger(),
      clock,
      rng: seededRng(1),
      settings: bundle.defaultSettings({ tz: TZ, protected: [FILTER] }),
    };
    const { output } = await bundle.startDiagnosis({ symptom: "the hallway lamp isn't responding" }, deps);
    expect(output.question?.text).toBe("I'll flash the hallway lamp twice. Did it blink?");
  });
});
