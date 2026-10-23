// npm run video:verify (compose runs it too). Checks the final MP4 against the timeline and the recording:
// streams, duration under 2:55, a clean full decode, loudness per speech window and silence between them,
// burned in captions, no third party name on screen or in speech, and the contact sheet.
// Writes out/verify.json and exits 1 on any failure.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ffmpeg, probe } from './src/ffmpeg.ts';
import { rmsDb } from './src/audio.ts';
import { CAPTION_BAND } from './src/ass.ts';
import { findMarks, findNonEnglish } from './src/marks.ts';
import { CONTACT_SHEET, FINAL_FILE, FRAMES_FILE, RECORD_FILE, TIMELINE_FILE, VERIFY_FILE } from './src/paths.ts';
import type { Timeline } from './src/timeline.ts';
import type { RecordResult } from './record.ts';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** 2:55, five seconds inside the rules' three minutes. */
export const LIMIT_SEC = 175;

async function grayBand(file: string, t: number): Promise<Uint8Array> {
  const { x, y, w, h } = CAPTION_BAND;
  const r = await ffmpeg(['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-']);
  return new Uint8Array(r.stdout);
}

export async function verify(tl: Timeline): Promise<{ pass: boolean; checks: Check[]; summary: Record<string, unknown> }> {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
  };

  const p = await probe(FINAL_FILE);
  const v = p.video;
  const a = p.audio;
  add('video stream', !!v && v.codec === 'h264' && v.profile === 'High' && v.pixFmt === 'yuv420p' && v.width === 1920 && v.height === 1080 && v.fps === 30, JSON.stringify(v));
  add('audio stream', !!a && a.codec === 'aac' && a.rate === 48000 && a.channels === 'stereo', JSON.stringify(a));
  const dur = p.duration ?? 0;
  add('duration', Math.abs(dur - tl.duration) <= 0.1 && dur < LIMIT_SEC, `${dur.toFixed(2)} s (timeline ${tl.duration} s, limit ${LIMIT_SEC} s)`);

  const dec = await ffmpeg(['-v', 'error', '-xerror', '-i', FINAL_FILE, '-f', 'null', '-']);
  const errLines = dec.stderr.split('\n').filter((l) => l.trim()).length;
  add('decode', dec.code === 0 && errLines === 0, `exit ${dec.code}, ${errLines} error lines`);

  // Loudness from the final file's own audio (mono 16 kHz is enough for levels).
  const rate = 16000;
  const pcmOut = await ffmpeg(['-v', 'error', '-i', FINAL_FILE, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-']);
  const buf = pcmOut.stdout;
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const inside = <T extends { start: number }>(xs: T[]): T[] => xs.filter((x) => x.start < dur - 0.5);
  const speech = inside(tl.audio).filter((e) => e.start + e.dur <= dur).map((e) => ({ id: e.id, role: e.role, db: rmsDb(pcm, Math.round(e.start * rate), Math.round((e.start + e.dur) * rate)) }));
  const quietest = speech.reduce((m, s) => (s.db < m.db ? s : m), speech[0] ?? { id: '', role: 'narrator', db: 0 });
  const byRole: Record<string, number[]> = {};
  for (const s of speech) (byRole[s.role] ??= []).push(s.db);
  const med = (xs: number[]): number => {
    const s = [...xs].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)] ?? -Infinity;
  };
  add('speech loudness', speech.every((s) => s.db > -32), `${speech.length} windows, quietest ${quietest.db.toFixed(1)} dB (${quietest.id}); median ${Object.entries(byRole).map(([r, xs]) => `${r} ${med(xs).toFixed(1)} dB`).join(', ')}`);
  // Gaps of 0.4 s or more with no speech must be near silent (no stray audio).
  const sorted = [...inside(tl.audio)].sort((x, y) => x.start - y.start);
  const gaps: Array<{ from: number; to: number; db: number }> = [];
  let edge = 0;
  for (const e of sorted) {
    if (e.start - edge >= 0.4) gaps.push({ from: edge + 0.05, to: e.start - 0.05, db: rmsDb(pcm, Math.round((edge + 0.05) * rate), Math.round((e.start - 0.05) * rate)) });
    edge = Math.max(edge, e.start + e.dur);
  }
  const loudGap = gaps.reduce((m, g) => (g.db > m.db ? g : m), gaps[0] ?? { from: 0, to: 0, db: -Infinity });
  add('silence between lines', gaps.every((g) => g.db < -55), `${gaps.length} gaps, loudest ${Number.isFinite(loudGap.db) ? loudGap.db.toFixed(1) : '-inf'} dB at ${loudGap.from.toFixed(2)} s`);

  // Caption band: compare the final frame with the caption free capture at the middle of each narrator line.
  const samples = inside(tl.captions).filter((_, i) => i % 2 === 0).slice(0, 14);
  const changed: number[] = [];
  if (existsSync(FRAMES_FILE)) {
    for (const c of samples) {
      const mid = (c.start + c.end) / 2;
      const [f, g] = await Promise.all([grayBand(FINAL_FILE, mid), grayBand(FRAMES_FILE, mid)]);
      let n = 0;
      for (let i = 0; i < Math.min(f.length, g.length); i++) if (Math.abs((f[i] as number) - (g[i] as number)) > 40) n++;
      changed.push(f.length ? n / f.length : 0);
    }
  }
  add('caption band', changed.length > 0 && changed.every((x) => x > 0.01), `${changed.length} narrator lines sampled, changed pixel share min ${changed.length ? Math.min(...changed).toFixed(3) : 'n/a'}, max ${changed.length ? Math.max(...changed).toFixed(3) : 'n/a'}`);
  add('contact sheet', existsSync(CONTACT_SHEET), CONTACT_SHEET);

  const said = [...tl.audio.map((a) => a.text), ...tl.captions.map((c) => c.text), ...tl.labels.map((l) => l.text)].join('\n');
  const spokenMarks = findMarks(said);
  const rec = existsSync(RECORD_FILE) ? (JSON.parse(readFileSync(RECORD_FILE, 'utf8')) as RecordResult) : null;
  const shown = rec?.scan ?? null;
  add(
    'no third party names',
    spokenMarks.length === 0 && !!shown && shown.samples > 0 && shown.marks.length === 0,
    `speech, captions and labels: ${spokenMarks.join(', ') || 'none'}; screen: ${shown ? `${shown.samples} scans, ${shown.marks.length} with a name${shown.marks.length ? ` (${shown.marks.slice(0, 3).map((m) => `${m.t}s ${m.marks.join('/')}`).join('; ')})` : ''}; standards named ${shown.standards.join(', ') || 'none'}` : 'no scan in record.json'}`,
  );
  const hindiSaid = findNonEnglish(said);
  const hindiShown = shown?.nonEnglish ?? null;
  add(
    'english only',
    hindiSaid.length === 0 && !!hindiShown && hindiShown.length === 0,
    `speech, captions and labels: ${hindiSaid.join(', ') || 'none'}; screen: ${hindiShown ? `${hindiShown.length} scans with a Hindi word${hindiShown.length ? ` (${hindiShown.slice(0, 3).map((m) => `${m.t}s ${m.words.join('/')}`).join('; ')})` : ''}` : 'no scan in record.json'}`,
  );

  const pass = checks.every((c) => c.pass);
  const summary = { file: FINAL_FILE, duration: dur, streams: p.raw, speechWindows: speech.length, gaps: gaps.length };
  writeFileSync(VERIFY_FILE, JSON.stringify({ pass, checks, summary, speech, gaps, captionBand: changed }, null, 2));
  return { pass, checks, summary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tl = JSON.parse(readFileSync(TIMELINE_FILE, 'utf8')) as Timeline;
  const r = await verify(tl);
  for (const c of r.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(22)} ${c.detail}`);
  if (!r.pass) process.exit(1);
}
