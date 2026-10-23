import { describe, expect, it } from 'vitest';
import { createAuthGate } from '../src/auth.ts';
import { haError, isHaError, type HaError } from '../src/errors.ts';

const rejectedToken = () => haError('auth', 'GET /api/states answered HTTP 401', { status: 401 });

async function failure(p: Promise<unknown>): Promise<HaError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isHaError(err)) throw new Error(`expected an HaError, got ${String(err)}`);
  return err;
}

describe('createAuthGate', () => {
  it('sends one call while the token is unproven; the others wait for its verdict', async () => {
    let now = 0;
    const gate = createAuthGate({ holdMs: 1000, now: () => now });
    const sent: string[] = [];
    const send = (label: string) => () => {
      sent.push(label);
      return Promise.reject(rejectedToken());
    };
    const errors = await Promise.all(['a', 'b', 'c'].map((l) => failure(gate.run(l, send(l)))));
    expect(sent).toEqual(['a']);
    expect(errors.map((e) => e.kind)).toEqual(['auth', 'auth', 'auth']);
    expect(errors[1]?.message).toMatch(/^b was not sent/);
    expect(errors[1]?.status).toBe(401);
    expect(gate.held()?.message).toMatch(/401/);
    now = 1000;
    expect(gate.held()).toBeUndefined();
    await failure(gate.run('d', send('d')));
    expect(sent).toEqual(['a', 'd']);
  });

  it('lets every call through at once after a token is proven, also by an answer that is not an auth error', async () => {
    const gate = createAuthGate();
    const notFound = haError('not_found', 'no such entity', { status: 404 });
    await failure(gate.run('probe', () => Promise.reject(notFound)));
    let inFlight = 0;
    let most = 0;
    const slow = () => {
      inFlight++;
      most = Math.max(most, inFlight);
      return new Promise<number>((resolve) => setTimeout(() => resolve(inFlight--), 5));
    };
    await Promise.all([gate.run('a', slow), gate.run('b', slow), gate.run('c', slow)]);
    expect(most).toBe(3);
  });

  it('does not prove a token on a network failure, and does not queue callers behind it either', async () => {
    const gate = createAuthGate();
    const sent: string[] = [];
    const down = (label: string) => () => {
      sent.push(label);
      return Promise.reject(haError('unreachable', 'connection refused'));
    };
    const errors = await Promise.all(['a', 'b', 'c'].map((l) => failure(gate.run(l, down(l)))));
    expect(errors.map((e) => e.kind)).toEqual(['unreachable', 'unreachable', 'unreachable']);
    expect(sent.sort()).toEqual(['a', 'b', 'c']);
    expect(gate.held()).toBeUndefined();
  });

  it('holds back again when a proven token is revoked later', async () => {
    let now = 0;
    const gate = createAuthGate({ holdMs: 500, now: () => now });
    expect(await gate.run('ok', () => Promise.resolve(1))).toBe(1);
    await failure(gate.run('revoked', () => Promise.reject(rejectedToken())));
    let sent = false;
    const err = await failure(
      gate.run('next', () => {
        sent = true;
        return Promise.resolve(2);
      }),
    );
    expect(err.message).toMatch(/was not sent/);
    expect(sent).toBe(false);
    now = 501;
    expect(await gate.run('later', () => Promise.resolve(3))).toBe(3);
  });
});
