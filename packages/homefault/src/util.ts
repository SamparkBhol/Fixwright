/** Deep copy of plain JSON data. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The record's own value under a key. Ids reach SimHome from outside (agents, HTTP bodies, scenario
 * files), and a plain object lookup with '__proto__', 'constructor' or 'toString' would read through to
 * Object.prototype, and a write through it would change every object in the isolate.
 */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Keys that must never become a property name in a plain object map. */
export const isReservedKey = (key: string): boolean => RESERVED_KEYS.has(key);

/** UTF-8 length of a string, computed without TextEncoder so it runs anywhere. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** How a voice assistant compares spoken names: case, punctuation and spacing do not matter. */
export const foldName = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Error with a stable machine readable code. */
export interface CodedError extends Error {
  code: string;
}

export function codedError(name: string, code: string, message: string): CodedError {
  const err = new Error(message) as CodedError;
  err.name = name;
  err.code = code;
  return err;
}

export const isCodedError = (e: unknown): e is CodedError =>
  e instanceof Error && typeof (e as Partial<CodedError>).code === 'string';
