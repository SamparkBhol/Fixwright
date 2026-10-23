// Sealing secrets a household stores (the linked Home Assistant token): AES-256-GCM with a key derived by
// HKDF-SHA256 from a Worker secret (HA_TOKEN_KEY, or CONFIRM_SECRET when that is not set), never stored with
// the data. The household id is the additional data, so a sealed token copied into another household's
// storage does not open. Format: "v1.<base64url iv>.<base64url ciphertext and tag>".

import { base64url, fromBase64url } from './crypto.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VERSION = 'v1';
const INFO = 'fixwright household token seal v1';

const keys = new Map<string, Promise<CryptoKey>>();

function sealKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle
      .importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
      .then((base) =>
        crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('fixwright'), info: encoder.encode(INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
      );
    keys.set(secret, key);
  }
  return key;
}

export async function seal(secret: string, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, await sealKey(secret), encoder.encode(plaintext));
  return `${VERSION}.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

/** The plaintext, or null when the value is malformed, was sealed under another key, or for another aad. */
export async function unseal(secret: string, value: string, aad: string): Promise<string | null> {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  try {
    const iv = fromBase64url(parts[1] as string);
    const data = fromBase64url(parts[2] as string);
    if (iv.byteLength !== 12 || data.byteLength < 16) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, await sealKey(secret), data);
    return decoder.decode(plain);
  } catch {
    return null;
  }
}
