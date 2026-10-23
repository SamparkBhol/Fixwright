// Per-case checkpoint for long baseline runs. Every finished baseline case is appended to a JSON lines
// file next to the result as soon as it is scored, so a run that crashes (or is stopped) resumes with
// --resume and only the missing cases are sent to the model again. The first line names the run's
// configuration by hash; a checkpoint from a different configuration is refused, never mixed in.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { CaseRow } from './metrics.ts';

export const CHECKPOINT_FORMAT = 'hometruth.checkpoint/1';

interface Header {
  type: 'header';
  format: typeof CHECKPOINT_FORMAT;
  fingerprint: string;
  config: unknown;
}

interface RowLine {
  type: 'row';
  row: CaseRow;
}

/** Stable JSON: object keys sorted, so the same configuration always hashes the same. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintOf(config: unknown): string {
  return createHash('sha256').update(stableJson(config)).digest('hex');
}

export const CHECKPOINT_MISMATCH = 'checkpoint_mismatch';

function mismatch(path: string): Error & { code: string } {
  const message = `The checkpoint ${path} belongs to a run with different settings or scenarios. Rerun with the same flags, or pass --fresh to discard it.`;
  return Object.assign(new Error(message), { code: CHECKPOINT_MISMATCH });
}

/**
 * Reads the rows of a checkpoint written for `fingerprint`. A missing file reads as no rows. A last
 * line cut off by a crash is skipped; any other unreadable line is an error, since it means the file
 * was edited or corrupted.
 */
export function readCheckpoint(path: string, fingerprint: string): CaseRow[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return [];
  const parse = (line: string, i: number): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      if (i === lines.length - 1) return null;
      throw new Error(`${path} line ${i + 1} is not valid JSON`);
    }
  };
  const header = parse(lines[0] as string, 0) as Header | null;
  if (!header || header.type !== 'header' || header.format !== CHECKPOINT_FORMAT) throw new Error(`${path} is not a HomeTruth checkpoint`);
  if (header.fingerprint !== fingerprint) throw mismatch(path);
  const rows: CaseRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = parse(lines[i] as string, i) as RowLine | null;
    if (line?.type === 'row') rows.push(line.row);
  }
  return rows;
}

export interface CheckpointWriter {
  path: string;
  append(row: CaseRow): void;
  /** Deletes the file once the final result is written. */
  remove(): void;
}

/** Starts a checkpoint file (header plus any rows carried over from a resumed run). */
export function openCheckpoint(path: string, fingerprint: string, config: unknown, carried: readonly CaseRow[] = []): CheckpointWriter {
  mkdirSync(dirname(path), { recursive: true });
  const header: Header = { type: 'header', format: CHECKPOINT_FORMAT, fingerprint, config };
  const body = [header, ...carried.map((row): RowLine => ({ type: 'row', row }))].map((l) => JSON.stringify(l)).join('\n');
  writeFileSync(path, body + '\n');
  return {
    path,
    append: (row) => appendFileSync(path, JSON.stringify({ type: 'row', row } satisfies RowLine) + '\n'),
    remove: () => rmSync(path, { force: true }),
  };
}
