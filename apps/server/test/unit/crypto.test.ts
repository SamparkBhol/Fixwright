import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32,
  base64url,
  canonicalJson,
  issueHouseholdToken,
  seedFor,
  signConfirmToken,
  timingSafeEqual,
  verifyConfirmToken,
  verifyHouseholdToken,
} from '../../src/lib/crypto.ts';

const SECRET = 'unit-test-secret-unit-test-secret-0001';

describe('confirm tokens', () => {
  it('is HMAC-SHA256(secret, plan_id|plan_hash|expires_at) in base64url', async () => {
    const token = await signConfirmToken(SECRET, 'pln_a', 'hash1', '2026-10-15T22:05:00.000Z');
    const expected = createHmac('sha256', SECRET).update('pln_a|hash1|2026-10-15T22:05:00.000Z').digest('base64url');
    expect(token).toBe(expected);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('verifies only the exact plan, hash and expiry it was signed for', async () => {
    const token = await signConfirmToken(SECRET, 'pln_a', 'hash1', '2026-10-15T22:05:00.000Z');
    expect(await verifyConfirmToken(SECRET, token, 'pln_a', 'hash1', '2026-10-15T22:05:00.000Z')).toBe(true);
    expect(await verifyConfirmToken(SECRET, token, 'pln_b', 'hash1', '2026-10-15T22:05:00.000Z')).toBe(false);
    expect(await verifyConfirmToken(SECRET, token, 'pln_a', 'hash2', '2026-10-15T22:05:00.000Z')).toBe(false);
    expect(await verifyConfirmToken(SECRET, token, 'pln_a', 'hash1', '2026-10-15T22:10:00.000Z')).toBe(false);
    expect(await verifyConfirmToken('another-secret-another-secret-0002', token, 'pln_a', 'hash1', '2026-10-15T22:05:00.000Z')).toBe(false);
    expect(await verifyConfirmToken(SECRET, `${token.slice(0, -1)}A`, 'pln_a', 'hash1', '2026-10-15T22:05:00.000Z')).toBe(token.endsWith('A'));
  });

  it('compares in constant structure: equal strings, different lengths, one byte off', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('hashes plans by content, not key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    expect(canonicalJson({ a: 1, skip: undefined })).toBe('{"a":1}');
  });
});

describe('household tokens', () => {
  it('issues tokens the server can verify without storage', async () => {
    const token = await issueHouseholdToken(SECRET);
    expect(token).toMatch(/^hh_[0-9a-z]{32}$/);
    expect(await verifyHouseholdToken(SECRET, token)).toBe(true);
    expect(await verifyHouseholdToken('another-secret-another-secret-0002', token)).toBe(false);
  });

  it('refuses invented and altered tokens, accepts hh_public', async () => {
    const token = await issueHouseholdToken(SECRET);
    const flipped = token.slice(0, 5) + (token[5] === 'a' ? 'b' : 'a') + token.slice(6);
    expect(await verifyHouseholdToken(SECRET, flipped)).toBe(false);
    expect(await verifyHouseholdToken(SECRET, 'hh_guess')).toBe(false);
    expect(await verifyHouseholdToken(SECRET, 'hh_public')).toBe(true);
  });

  it('gives hh_public seed 1 and other households a stable seed from 1 to 500', () => {
    expect(seedFor('hh_public')).toBe(1);
    const s = seedFor('hh_abc');
    expect(s).toBe(seedFor('hh_abc'));
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(500);
  });
});

describe('encodings', () => {
  it('base64url has no padding or + and /', () => {
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe('-__-');
  });
  it('base32 uses the Crockford lower case alphabet', () => {
    expect(base32(new Uint8Array([0, 0, 0, 0, 0]), 8)).toBe('00000000');
    expect(base32(new Uint8Array([255, 255, 255, 255, 255]), 8)).toBe('zzzzzzzz');
  });
});
