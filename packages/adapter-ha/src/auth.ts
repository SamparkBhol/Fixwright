// One token, one verdict. Home Assistant counts every rejected token (HTTP 401 or 403, websocket
// auth_invalid) toward its ip_ban login_attempts_threshold, and the engine's checkup fans out many reads
// at once. So until a token has been accepted once, only one request or websocket login goes out and the
// others wait for its answer; after a rejection, every call fails at once for `holdMs` without sending
// anything. Shared by the REST client and the websocket handshake.

import { haError, isHaError, type HaError } from './errors.ts';

export interface AuthGate {
  /**
   * Sends through the gate. While the token is unproven, a call that finds another one in flight waits
   * for it once (then goes, even if that one failed for another reason, so a dead hub does not queue
   * every call behind the previous timeout).
   */
  run<T>(label: string, send: () => Promise<T>): Promise<T>;
  /** The rejection that holds calls back right now, if any. */
  held(): HaError | undefined;
}

export const DEFAULT_AUTH_HOLD_MS = 30_000;

/** Errors that prove Home Assistant got past its auth check: it answered with something else. */
const answered = (err: HaError): boolean => err.status !== undefined || err.code !== undefined;

export function createAuthGate(opts: { holdMs?: number; now?: () => number } = {}): AuthGate {
  const holdMs = opts.holdMs ?? DEFAULT_AUTH_HOLD_MS;
  const now = opts.now ?? (() => Date.now());
  let proven = false;
  let probe: Promise<void> | undefined;
  let rejection: { err: HaError; until: number } | undefined;

  function held(): HaError | undefined {
    if (rejection && now() >= rejection.until) rejection = undefined;
    return rejection?.err;
  }

  function run<T>(label: string, send: () => Promise<T>, waited = false): Promise<T> {
    const h = held();
    if (h) {
      return Promise.reject(
        haError('auth', `${label} was not sent: Home Assistant refused this token moments ago (${h.message})`, {
          ...(h.status === undefined ? {} : { status: h.status }),
          cause: h,
        }),
      );
    }
    if (!proven && probe && !waited) return probe.then(() => run(label, send, true));
    const result = send().then(
      (value) => {
        proven = true;
        return value;
      },
      (err: unknown) => {
        if (isHaError(err) && err.kind === 'auth') {
          proven = false;
          rejection = { err, until: now() + holdMs };
        } else if (isHaError(err) && answered(err)) {
          proven = true;
        }
        throw err;
      },
    );
    if (!proven) {
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      probe = settled;
      void settled.then(() => {
        if (probe === settled) probe = undefined;
      });
    }
    return result;
  }

  return { run: (label, send) => run(label, send), held };
}
