import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROTOCOL_FIXTURES = path.resolve(ROOT, '..', '..', 'packages', 'protocol', 'fixtures');
export const VIEW_FIXTURES = path.join(ROOT, 'fixtures');

export function fixture<T = Record<string, unknown>>(name: string): T {
  const [dir, file] = name.split('/') as [string, string];
  const base = dir === 'protocol' ? PROTOCOL_FIXTURES : VIEW_FIXTURES;
  return JSON.parse(readFileSync(path.join(base, `${file}.json`), 'utf8')) as T;
}

export function fixtureNames(dir: 'protocol' | 'views'): string[] {
  const base = dir === 'protocol' ? PROTOCOL_FIXTURES : VIEW_FIXTURES;
  return readdirSync(base)
    .filter((f) => f.endsWith('.json'))
    .map((f) => `${dir}/${f.slice(0, -5)}`)
    .sort();
}

/** 2026-10-15 10:21 in Los Angeles: the golden path afternoon (UTC 17:21). */
export const T = { locale: 'en-US', timeZone: 'America/Los_Angeles', nowMs: Date.parse('2026-10-15T17:21:00.000Z') };
