// Errors the adapter raises. Every failure says which of a few things went wrong, so callers can tell
// "the hub is down" from "the token is wrong" from "that entity does not exist" without parsing text.

import { protocolError, type ProtocolError } from '@fixwright/protocol';

export const HA_ERROR_KINDS = [
  /** Network failure: connection refused, DNS, TLS, socket closed. */
  'unreachable',
  /** The request or command took longer than its deadline. */
  'timeout',
  /** HTTP 401 or 403, or websocket auth_invalid: the token is wrong, revoked or lacks admin rights. */
  'auth',
  /** HTTP 404 or websocket not_found: the entity, entry or integration does not exist. */
  'not_found',
  /** HTTP 400 or websocket invalid_format: Home Assistant rejected the request as malformed. */
  'bad_request',
  /** HTTP 5xx or 429. */
  'server',
  /** A response that does not have the shape Home Assistant documents. */
  'protocol',
  /** A websocket command failed with another error code. */
  'command_failed',
  /** The change was sent but reading it back did not show it within the deadline. */
  'readback',
  /** The adapter refused to act (for example a service on a lock); `refusal` says why. */
  'refused',
  /** Home Assistant can only do this with a step the adapter never takes itself (a restart). */
  'unsupported',
] as const;
export type HaErrorKind = (typeof HA_ERROR_KINDS)[number];

export interface HaError extends Error {
  readonly name: 'HaError';
  readonly kind: HaErrorKind;
  /** HTTP status, when the failure came from a REST call. */
  readonly status?: number;
  /** Websocket error code, when the failure came from a websocket command. */
  readonly code?: string;
  /** Trying the same call again later may work. */
  readonly retryable: boolean;
  /** Server hint from a Retry-After header. */
  readonly retryAfterMs?: number;
  /** For kind 'refused': the call reached something unsafe, or the adapter could not see what it would reach. */
  readonly refusal?: Refusal;
}

/**
 * unsafe_device: the call targets a lock, alarm, camera, siren or garage, gate or door cover.
 * unverified: the adapter cannot tell what the call would touch (a script, an unknown device, a hub restart).
 */
export type Refusal = 'unsafe_device' | 'unverified';

const RETRYABLE: ReadonlySet<HaErrorKind> = new Set(['unreachable', 'timeout', 'server']);

export function haError(
  kind: HaErrorKind,
  message: string,
  extra: { status?: number; code?: string; cause?: unknown; retryAfterMs?: number; refusal?: Refusal } = {},
): HaError {
  const err = new Error(message, extra.cause === undefined ? undefined : { cause: extra.cause });
  return Object.assign(err, {
    name: 'HaError' as const,
    kind,
    retryable: RETRYABLE.has(kind),
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.code === undefined ? {} : { code: extra.code }),
    ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
    ...(kind === 'refused' ? { refusal: extra.refusal ?? 'unsafe_device' } : {}),
  });
}

export function isHaError(value: unknown): value is HaError {
  if (!(value instanceof Error) || value.name !== 'HaError') return false;
  const kind: unknown = (value as unknown as Record<string, unknown>)['kind'];
  return typeof kind === 'string' && (HA_ERROR_KINDS as readonly string[]).includes(kind);
}

/** Classifies an HTTP status the way the adapter reports it. */
export function kindForStatus(status: number): HaErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429 || status >= 500) return 'server';
  return 'bad_request';
}

/**
 * Classifies a websocket result error code (homeassistant/components/websocket_api/const.py, 2026.9.4).
 * home_assistant_error is a handler that refused the request on purpose, so it is not retried;
 * only unknown_error (an unexpected exception) counts as a server fault worth another try.
 */
export function kindForWsCode(code: string | undefined): HaErrorKind {
  switch (code) {
    case 'not_found':
      return 'not_found';
    case 'unauthorized':
      return 'auth';
    case 'invalid_format':
    case 'not_supported':
    case 'not_allowed':
    case 'unknown_command':
    case 'service_validation_error':
    case 'template_error':
      return 'bad_request';
    case 'timeout':
      return 'timeout';
    case 'unknown_error':
      return 'server';
    default:
      return 'command_failed';
  }
}

/** What the person hears when the adapter could not check what a call would touch. */
export const UNVERIFIED_SPEECH = "I only change devices I can check first, so I left that one alone.";
/** What the person hears when an integration only reloads with a restart. */
export const RESTART_SPEECH = 'That integration only reloads when Home Assistant restarts, and I leave restarts to you.';

/**
 * Turns any adapter failure into the protocol's ProtocolError, so the server can answer with one
 * spoken line. Unknown values become 'internal'.
 */
export function toProtocolError(value: unknown): ProtocolError {
  if (!isHaError(value)) {
    return protocolError('internal', value instanceof Error ? value.message : String(value));
  }
  switch (value.kind) {
    case 'unreachable':
    case 'timeout':
      return protocolError('hub_unreachable', value.message);
    case 'auth':
      return protocolError(
        'adapter_error',
        value.message,
        "Home Assistant didn't accept my access key. Please link it again in the Fixwright settings.",
      );
    case 'not_found':
      return protocolError('not_found', value.message);
    case 'refused':
      return value.refusal === 'unverified'
        ? protocolError('unsafe_device', value.message, UNVERIFIED_SPEECH)
        : protocolError('unsafe_device', value.message);
    case 'unsupported':
      return protocolError('no_fix', value.message, RESTART_SPEECH);
    case 'bad_request':
    case 'server':
    case 'protocol':
    case 'command_failed':
    case 'readback':
      return protocolError('adapter_error', value.message);
  }
}
