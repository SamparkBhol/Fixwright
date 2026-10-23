import { DIAGNOSIS_CAUSE_IDS } from '@fixwright/protocol';
import { z } from 'zod/v4';

/**
 * What an LLM baseline may answer: the diagnosis causes from the shared contract (the same
 * list the engine ranks and homefault uses as ground truth), plus 'unknown' so the model can abstain.
 * Derived, never copied, so it cannot drift from @fixwright/protocol.
 */
export const LLM_CAUSE_IDS = [...DIAGNOSIS_CAUSE_IDS, 'unknown'] as const;

export type LlmCauseId = (typeof LLM_CAUSE_IDS)[number];

/** The answer every LLM-only baseline must return. "Confirmed" means confidence >= 0.9. */
export interface LlmVerdict {
  cause_id: string;
  confidence: number;
  explanation: string;
}

export const CONFIRMED_THRESHOLD = 0.9;

/** Builds the zod schema for a verdict whose cause_id must be one of `causeIds`. */
export function verdictSchema(causeIds: readonly [string, ...string[]] = LLM_CAUSE_IDS) {
  return z
    .object({
      cause_id: z.enum(causeIds).describe('The single most likely root cause id from the allowed list.'),
      confidence: z.number().min(0).max(1).describe('Probability from 0 to 1 that cause_id is right.'),
      explanation: z.string().min(1).max(600).describe('One or two plain sentences citing the log lines that support it.'),
    })
    .strict()
    .describe('Diagnosis of a smart home fault.');
}

export type VerdictSchema = ReturnType<typeof verdictSchema>;

/** JSON Schema (draft 2020-12) for OpenAI-style `response_format: json_schema`, derived from the zod schema. */
export function verdictJsonSchema(causeIds: readonly [string, ...string[]] = LLM_CAUSE_IDS): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(verdictSchema(causeIds)) as Record<string, unknown>;
  return schema;
}

export type ParseResult = { ok: true; verdict: LlmVerdict } | { ok: false; error: string };

/**
 * Parses model text into a verdict. Accepts a bare JSON object, a fenced ```json block, or a JSON
 * object surrounded by prose (small models sometimes add a sentence). Never throws.
 */
export function parseVerdict(text: string, causeIds: readonly [string, ...string[]] = LLM_CAUSE_IDS): ParseResult {
  const candidate = extractJsonObject(text);
  if (candidate === null) return { ok: false, error: 'no JSON object found in model output' };
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  return validateVerdict(value, causeIds);
}

/** Validates an already parsed value (for example a Strands structuredOutput) against the schema. */
export function validateVerdict(value: unknown, causeIds: readonly [string, ...string[]] = LLM_CAUSE_IDS): ParseResult {
  const parsed = verdictSchema(causeIds).safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, error: `schema mismatch: ${issues.join('; ')}` };
  }
  return { ok: true, verdict: parsed.data };
}

/** Returns the first balanced top-level JSON object in `text`, honouring strings and escapes. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function isConfirmed(v: LlmVerdict): boolean {
  return v.confidence >= CONFIRMED_THRESHOLD;
}
