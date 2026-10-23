import { describe, expect, it } from 'vitest';
import {
  CAUSE_IDS,
  CAUSE_LABELS,
  DIAGNOSIS_CAUSE_IDS,
  FINDING_KINDS,
  FINDING_LABELS,
  PROBE_IDS,
  PROBE_KINDS,
  PROBLEM_CODES,
  PROBLEM_DEFAULTS,
  ProblemOutputSchema,
  assertNever,
  isProtocolError,
  problemOutput,
  protocolError,
  speechProblems,
} from '../src/index.ts';

const BANNED = /\b(seamless|unlock|journey|leverage|robust|delve|elevate|empower|cutting edge|game changer)\b|[\u2013\u2014]|\s-\s/i;

describe('label tables', () => {
  it('cover every diagnosis cause id plus the explain_event causes', () => {
    expect([...DIAGNOSIS_CAUSE_IDS]).toEqual([
      'stale_duplicate',
      'device_power_lost',
      'radio_link_weak',
      'hub_down',
      'vendor_cloud_outage',
      'account_link_expired',
      'power_on_default_on',
      'name_collision',
      'dead_trigger',
      'wifi_network_changed',
    ]);
    expect(Object.keys(CAUSE_LABELS).sort()).toEqual([...CAUSE_IDS].sort());
  });

  it('cover every finding kind', () => {
    expect(Object.keys(FINDING_LABELS).sort()).toEqual([...FINDING_KINDS].sort());
    expect(FINDING_KINDS).toHaveLength(8);
  });

  it('classify every library probe', () => {
    expect(Object.keys(PROBE_KINDS).sort()).toEqual([...PROBE_IDS].sort());
    expect(PROBE_KINDS.flash_test).toBe('active');
    expect(PROBE_KINDS.confirm_flash).toBe('human');
  });

  it('are short, plain and free of banned words', () => {
    for (const { label, detail } of [...Object.values(CAUSE_LABELS), ...Object.values(FINDING_LABELS)]) {
      expect(label.length, label).toBeLessThanOrEqual(34);
      expect(label, label).not.toMatch(BANNED);
      expect(detail, detail).not.toMatch(BANNED);
      expect(detail.endsWith('.'), detail).toBe(true);
    }
  });
});

describe('ProtocolError', () => {
  it('has a speech safe default line for every code', () => {
    for (const code of PROBLEM_CODES) {
      expect(speechProblems(PROBLEM_DEFAULTS[code].speech), code).toEqual([]);
      expect(PROBLEM_DEFAULTS[code].speech, code).not.toMatch(BANNED);
    }
    expect(PROBLEM_DEFAULTS.hub_unreachable.speech).toBe("I couldn't reach your hub just now. Try again in a minute.");
  });

  it('builds errors with defaults or overrides and recognizes them', () => {
    const e = protocolError('plan_expired');
    expect(e).toEqual({ code: 'plan_expired', message: 'plan_expired', speech: PROBLEM_DEFAULTS.plan_expired.speech, retryable: false });
    const custom = protocolError('not_found', 'no entity matched "hall lamp"', "I couldn't find the hall lamp.");
    expect(custom.speech).toBe("I couldn't find the hall lamp.");
    expect(isProtocolError(custom)).toBe(true);
    expect(isProtocolError(new Error('x'))).toBe(false);
    expect(isProtocolError({ ...custom, code: 'nope' })).toBe(false);
    expect(isProtocolError(null)).toBe(false);
  });

  it('turns into a valid problem output with error or refused status', () => {
    const source = { adapter: 'home-assistant', simulated: false } as const;
    const err = problemOutput(protocolError('hub_unreachable'), source);
    expect(ProblemOutputSchema.parse(err)).toEqual(err);
    expect(err.status).toBe('error');
    const refused = problemOutput(protocolError('unsafe_device'), source, { plan_id: 'pln_01m50980d03sy1gk7c' });
    expect(refused.status).toBe('refused');
    expect(ProblemOutputSchema.safeParse(refused).success).toBe(true);
  });

  it('assertNever throws with the unexpected value', () => {
    expect(() => assertNever('surprise' as never, 'status')).toThrow('Unexpected status: "surprise"');
  });
});
