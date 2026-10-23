// npm run video:compose. Mixes the measured clips under out/frames.mp4, burns in the overlay and writes
// out/fixwright-demo.mp4 (H.264 High yuv420p 1080p30, AAC 48 kHz stereo), out/contact-sheet.png (a frame
// every 10 s) and the verify.ts checks.

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { decodeWav, encodeWav, levelGain, mix, type Placement } from './src/audio.ts';
import { buildAss } from './src/ass.ts';
import { ffmpegOk, probe } from './src/ffmpeg.ts';
import { ASS_FILE, CONTACT_SHEET, FINAL_FILE, FONTS_DIR, FRAMES_FILE, MIX_FILE, RECORD_FILE, TIMELINE_FILE, TTS_DIR, TTS_MANIFEST, VIDEO_DIR } from './src/paths.ts';
import type { Timeline } from './src/timeline.ts';
import type { TtsManifest } from './tts.ts';
import type { RecordResult } from './record.ts';
import { verify } from './verify.ts';

/** RMS targets in dBFS: narration a touch forward of the two conversation voices. */
const TARGET_DB = { narrator: -17, user: -18, reply: -18 } as const;

async function main(): Promise<void> {
  const t0 = performance.now();
  const tl = JSON.parse(readFileSync(TIMELINE_FILE, 'utf8')) as Timeline;
  const manifest = JSON.parse(readFileSync(TTS_MANIFEST, 'utf8')) as TtsManifest;
  const rec = JSON.parse(readFileSync(RECORD_FILE, 'utf8')) as RecordResult;
  const framesProbe = await probe(FRAMES_FILE);
  const duration = Math.min(tl.duration, framesProbe.duration ?? tl.duration);
  if (rec.fromFrame > 0) throw new Error('compose needs a capture that starts at 0 (record without --from)');
  if (rec.partial) console.warn(`frames.mp4 is a partial capture (${rec.fromFrame} to ${rec.toFrame}); composing ${duration.toFixed(2)} s`);

  const placements: Placement[] = tl.audio.map((e) => {
    const clip = manifest.clips[e.id];
    if (!clip) throw new Error(`clip ${e.id} missing from the TTS manifest`);
    const pcm = decodeWav(readFileSync(join(TTS_DIR, clip.file)));
    return { start: e.start, pcm, gain: levelGain(pcm.samples, TARGET_DB[e.role]) };
  });
  const mixed = mix(placements, duration, manifest.sampleRate);
  writeFileSync(MIX_FILE, encodeWav(mixed));

  const taps = rec.actions.filter((a) => a.tap).map((a) => ({ at: a.at, x: (a.tap as { x: number }).x, y: (a.tap as { y: number }).y }));
  writeFileSync(ASS_FILE, buildAss(tl, taps));

  // Relative paths inside the filter: libass and the filter parser dislike colons.
  const rel = (p: string): string => relative(VIDEO_DIR, p);
  const e0 = performance.now();
  await ffmpegOk(
    [
      '-y', '-i', rel(FRAMES_FILE), '-i', rel(MIX_FILE),
      '-filter_complex', `[0:v]subtitles=filename=${rel(ASS_FILE)}:fontsdir=${rel(FONTS_DIR)}[v];[1:a]aresample=48000,pan=stereo|c0=c0|c1=c0[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(tl.fps),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-t', duration.toFixed(3), rel(FINAL_FILE),
    ],
    { cwd: VIDEO_DIR },
  );
  const encodeSec = (performance.now() - e0) / 1000;

  const tiles = Math.floor(duration / 10) + 1;
  const rows = Math.ceil(tiles / 6);
  await ffmpegOk(
    ['-y', '-i', rel(FINAL_FILE), '-vf', `select='not(mod(n\\,${tl.fps * 10}))',scale=480:270,tile=6x${rows}:padding=6:margin=6:color=0x1C2228`, '-frames:v', '1', '-fps_mode', 'passthrough', rel(CONTACT_SHEET)],
    { cwd: VIDEO_DIR },
  );

  const composeSec = (performance.now() - t0) / 1000;
  const bytes = statSync(FINAL_FILE).size;
  console.log(`compose: ${FINAL_FILE} ${(bytes / 1e6).toFixed(2)} MB, ${duration.toFixed(2)} s, encode ${encodeSec.toFixed(1)} s, total ${composeSec.toFixed(1)} s`);

  const r = await verify({ ...tl, duration: +duration.toFixed(3) });
  for (const c of r.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(22)} ${c.detail}`);
  const stats = { bytes, duration, encodeSec: +encodeSec.toFixed(2), composeSec: +composeSec.toFixed(2) };
  writeFileSync(join(VIDEO_DIR, 'out', 'compose.json'), JSON.stringify(stats, null, 2));
  if (!r.pass) process.exit(1);
}

await main();
