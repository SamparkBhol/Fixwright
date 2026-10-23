import { DIAGNOSIS_CAUSE_IDS } from '@fixwright/protocol';
import { CAUSE_IDS as HOMEFAULT_CAUSE_IDS } from 'homefault';
import { describe, expect, it } from 'vitest';
import { systemPrompt } from '../src/prompt.ts';
import { extractJsonObject, isConfirmed, LLM_CAUSE_IDS, parseVerdict, validateVerdict, verdictJsonSchema } from '../src/verdict.ts';

const good = { cause_id: 'stale_duplicate', confidence: 0.82, explanation: 'Two entities share the name; the old one is restored and offline.' };

describe('LLM_CAUSE_IDS', () => {
  it('is the protocol diagnosis causes plus unknown, in protocol order', () => {
    expect(LLM_CAUSE_IDS).toEqual([...DIAGNOSIS_CAUSE_IDS, 'unknown']);
  });

  it('covers every ground truth cause homefault scenarios can carry', () => {
    for (const id of HOMEFAULT_CAUSE_IDS) expect(LLM_CAUSE_IDS).toContain(id);
  });

  it('lists every allowed cause in the system prompt', () => {
    const prompt = systemPrompt();
    for (const id of LLM_CAUSE_IDS) expect(prompt).toContain(`- ${id}: `);
  });
});

describe('parseVerdict', () => {
  it('accepts a bare JSON object', () => {
    const r = parseVerdict(JSON.stringify(good));
    expect(r).toEqual({ ok: true, verdict: good });
  });

  it('accepts a fenced json block and surrounding prose', () => {
    const r = parseVerdict(`Here is my answer:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\nHope that helps.`);
    expect(r.ok && r.verdict.cause_id).toBe('stale_duplicate');
  });

  it('handles braces inside strings', () => {
    const v = { ...good, explanation: 'Log row {"to":"unavailable"} and a stray } brace.' };
    const r = parseVerdict(`noise ${JSON.stringify(v)} trailing {`);
    expect(r).toEqual({ ok: true, verdict: v });
  });

  it('rejects text without JSON', () => {
    expect(parseVerdict('The hallway lamp is a ghost.')).toEqual({ ok: false, error: 'no JSON object found in model output' });
  });

  it('rejects an unbalanced object', () => {
    expect(parseVerdict('{"cause_id": "hub_down"').ok).toBe(false);
  });

  it('rejects malformed JSON with a reason', () => {
    const r = parseVerdict("{'cause_id': 'hub_down'}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^invalid JSON/);
  });

  it('rejects confidence outside 0..1', () => {
    const r = parseVerdict(JSON.stringify({ ...good, confidence: 1.4 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/confidence/);
  });

  it('rejects a cause id outside the library', () => {
    const r = parseVerdict(JSON.stringify({ ...good, cause_id: 'gremlins' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cause_id/);
  });

  it('rejects missing and extra fields', () => {
    expect(parseVerdict(JSON.stringify({ cause_id: 'hub_down', confidence: 0.5 })).ok).toBe(false);
    expect(parseVerdict(JSON.stringify({ ...good, mood: 'sure' })).ok).toBe(false);
  });

  it('supports a custom cause list', () => {
    expect(parseVerdict(JSON.stringify({ ...good, cause_id: 'x' }), ['x', 'y']).ok).toBe(true);
  });
});

describe('validateVerdict', () => {
  it('validates an already parsed object', () => {
    expect(validateVerdict(good).ok).toBe(true);
    expect(validateVerdict(undefined).ok).toBe(false);
  });
});

describe('extractJsonObject', () => {
  it('returns the first balanced object only', () => {
    expect(extractJsonObject('a {"x":{"y":1}} b {"z":2}')).toBe('{"x":{"y":1}}');
  });
  it('handles escaped quotes', () => {
    expect(extractJsonObject('{"s":"a \\"}\\" b"}')).toBe('{"s":"a \\"}\\" b"}');
  });
});

describe('verdictJsonSchema', () => {
  it('is a strict object schema with the cause enum, without $schema', () => {
    const s = verdictJsonSchema() as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: { cause_id: { enum: string[] }; confidence: { minimum: number; maximum: number } };
      $schema?: string;
    };
    expect(s.type).toBe('object');
    expect(s.$schema).toBeUndefined();
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(['cause_id', 'confidence', 'explanation']);
    expect(s.properties.cause_id.enum).toEqual([...LLM_CAUSE_IDS]);
    expect(s.properties.confidence).toMatchObject({ minimum: 0, maximum: 1 });
  });
});

describe('isConfirmed', () => {
  it('counts 0.9 as confirmed and 0.89 as not', () => {
    expect(isConfirmed({ ...good, confidence: 0.9 })).toBe(true);
    expect(isConfirmed({ ...good, confidence: 0.89 })).toBe(false);
  });
});
