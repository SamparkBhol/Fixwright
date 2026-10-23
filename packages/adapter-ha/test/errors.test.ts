import { describe, expect, it } from 'vitest';
import { isProtocolError, speechProblems } from '@fixwright/protocol';
import { haError, isHaError, kindForStatus, kindForWsCode, toProtocolError } from '../src/errors.ts';

describe('HaError', () => {
  it('is a real Error with a kind, status, code and retryable flag', () => {
    const err = haError('server', 'boom', { status: 503, retryAfterMs: 2000 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HaError');
    expect(err.kind).toBe('server');
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.retryable).toBe(true);
    expect(isHaError(err)).toBe(true);
  });

  it('marks only unreachable, timeout and server failures as retryable', () => {
    expect(haError('unreachable', 'x').retryable).toBe(true);
    expect(haError('timeout', 'x').retryable).toBe(true);
    expect(haError('auth', 'x').retryable).toBe(false);
    expect(haError('not_found', 'x').retryable).toBe(false);
    expect(haError('readback', 'x').retryable).toBe(false);
  });

  it('does not mistake other errors for HaErrors', () => {
    expect(isHaError(new Error('x'))).toBe(false);
    expect(isHaError({ name: 'HaError', kind: 'auth' })).toBe(false);
    expect(isHaError(Object.assign(new Error('x'), { name: 'HaError', kind: 'bogus' }))).toBe(false);
  });

  it('classifies HTTP statuses: unreachable vs auth vs not found', () => {
    expect(kindForStatus(401)).toBe('auth');
    expect(kindForStatus(403)).toBe('auth');
    expect(kindForStatus(404)).toBe('not_found');
    expect(kindForStatus(400)).toBe('bad_request');
    expect(kindForStatus(429)).toBe('server');
    expect(kindForStatus(502)).toBe('server');
  });

  it('classifies websocket error codes', () => {
    expect(kindForWsCode('not_found')).toBe('not_found');
    expect(kindForWsCode('unauthorized')).toBe('auth');
    expect(kindForWsCode('invalid_format')).toBe('bad_request');
    expect(kindForWsCode('unknown_command')).toBe('bad_request');
    expect(kindForWsCode('home_assistant_error')).toBe('command_failed');
    expect(kindForWsCode('service_validation_error')).toBe('bad_request');
    expect(kindForWsCode('unknown_error')).toBe('server');
    expect(haError(kindForWsCode('home_assistant_error'), 'x').retryable).toBe(false);
    expect(kindForWsCode('invalid_info')).toBe('command_failed');
    expect(kindForWsCode(undefined)).toBe('command_failed');
  });
});

describe('toProtocolError', () => {
  it('maps each failure to the protocol problem the person hears about', () => {
    expect(toProtocolError(haError('unreachable', 'x')).code).toBe('hub_unreachable');
    expect(toProtocolError(haError('timeout', 'x')).code).toBe('hub_unreachable');
    expect(toProtocolError(haError('not_found', 'x')).code).toBe('not_found');
    expect(toProtocolError(haError('refused', 'x')).code).toBe('unsafe_device');
    expect(toProtocolError(haError('refused', 'x')).speech).toMatch(/locks, garage doors/);
    expect(haError('refused', 'x').refusal).toBe('unsafe_device');
    expect(toProtocolError(haError('refused', 'x', { refusal: 'unverified' })).speech).toMatch(/check first/);
    expect(toProtocolError(haError('unsupported', 'x')).code).toBe('no_fix');
    expect(haError('unsupported', 'x').retryable).toBe(false);
    expect(haError('auth', 'x').refusal).toBeUndefined();
    expect(toProtocolError(haError('readback', 'x')).code).toBe('adapter_error');
    expect(toProtocolError(new Error('plain')).code).toBe('internal');
    expect(toProtocolError('text').code).toBe('internal');
  });

  it('gives an auth failure its own spoken line that passes the speech rules', () => {
    const p = toProtocolError(haError('auth', 'HTTP 401'));
    expect(isProtocolError(p)).toBe(true);
    expect(p.code).toBe('adapter_error');
    expect(p.speech).toMatch(/access key/);
    expect(speechProblems(p.speech)).toEqual([]);
    expect(p.message).toBe('HTTP 401');
  });
});
