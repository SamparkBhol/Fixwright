// Engine failures are thrown as Error objects that also carry the ProtocolError fields, so stack traces
// survive and the server can pass them straight to problemOutput().

import { isProtocolError, protocolError, type ProblemCode, type ProtocolError } from '@fixwright/protocol';

export type EngineError = Error & ProtocolError;

export function engineError(code: ProblemCode, message?: string, speech?: string): EngineError {
  const p = protocolError(code, message, speech);
  return Object.assign(new Error(p.message), p);
}

export function isEngineError(value: unknown): value is EngineError {
  return value instanceof Error && isProtocolError(value);
}
