// ProtocolError: how any module reports a failure that should reach the person as one spoken line.
// The server turns it into a ProblemOutput sent with isError: true.

import type { Ids, ProblemOutput, SourceInfo } from './types.ts';

export const PROBLEM_CODES = [
  'hub_unreachable',
  'adapter_error',
  'not_found',
  'ambiguous_device',
  'invalid_input',
  'session_expired',
  'question_answered',
  'plan_expired',
  'plan_used',
  'token_mismatch',
  'protected_load',
  'unsafe_device',
  'no_fix',
  'rate_limited',
  'internal',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export interface ProtocolError {
  code: ProblemCode;
  /** For logs and traces. Never spoken. */
  message: string;
  /** What the person hears. Plain, warm, short. */
  speech: string;
  /** Trying the same call again later may work. */
  retryable: boolean;
}

interface ProblemDefault {
  speech: string;
  retryable: boolean;
  /** 'refused' when Fixwright chose not to act; 'error' when something failed. */
  status: 'error' | 'refused';
}

export const PROBLEM_DEFAULTS: Readonly<Record<ProblemCode, ProblemDefault>> = {
  hub_unreachable: { status: 'error', retryable: true, speech: "I couldn't reach your hub just now. Try again in a minute." },
  adapter_error: { status: 'error', retryable: true, speech: "Your home system didn't answer properly just now. Try again in a minute." },
  not_found: { status: 'error', retryable: false, speech: "I couldn't find a device by that name. What do you call it?" },
  ambiguous_device: { status: 'error', retryable: false, speech: 'More than one device goes by that name. Which room is it in?' },
  invalid_input: { status: 'error', retryable: false, speech: "I didn't quite catch that. Could you say it again?" },
  session_expired: { status: 'error', retryable: false, speech: "I lost track of that check. Let's start it again." },
  question_answered: { status: 'refused', retryable: false, speech: 'That question already has an answer, so I kept the first one.' },
  plan_expired: { status: 'refused', retryable: false, speech: "That fix waited too long, so I didn't apply it. Want me to plan it again?" },
  plan_used: { status: 'refused', retryable: false, speech: 'That fix is already applied.' },
  token_mismatch: { status: 'refused', retryable: false, speech: "I couldn't match that yes to this fix, so I changed nothing. Want me to plan it again?" },
  protected_load: { status: 'refused', retryable: false, speech: "That device is protected, so I'll leave it running." },
  unsafe_device: { status: 'refused', retryable: false, speech: "I don't change locks, garage doors, alarms or cameras." },
  no_fix: { status: 'refused', retryable: false, speech: "I can't fix that one by myself." },
  rate_limited: { status: 'error', retryable: true, speech: "That's a lot of requests at once. Try again in a few seconds." },
  internal: { status: 'error', retryable: true, speech: 'Something went wrong on my side. Try again in a minute.' },
};

export function protocolError(code: ProblemCode, message?: string, speech?: string): ProtocolError {
  const d = PROBLEM_DEFAULTS[code];
  return { code, message: message ?? code, speech: speech ?? d.speech, retryable: d.retryable };
}

export function isProtocolError(value: unknown): value is ProtocolError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['code'] === 'string' &&
    (PROBLEM_CODES as readonly string[]).includes(v['code']) &&
    typeof v['message'] === 'string' &&
    typeof v['speech'] === 'string' &&
    typeof v['retryable'] === 'boolean'
  );
}

/** The structuredContent for an isError result. Pass the ids the call already knows about. */
export function problemOutput(error: ProtocolError, source: SourceInfo, ids: Ids = {}): ProblemOutput {
  return {
    speech: error.speech,
    status: PROBLEM_DEFAULTS[error.code].status,
    ids,
    source,
    problem: { code: error.code, retryable: error.retryable },
  };
}

/** Exhaustiveness guard for switch statements over closed unions. */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`Unexpected ${what}: ${JSON.stringify(value)}`);
}
