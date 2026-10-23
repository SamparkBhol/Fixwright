// npm run video:timeline (part of video:all). script.txt, out/tts/manifest.json and the HomeTruth result
// give out/timeline.json. Fails when the video would run past the script's MAX.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseScript } from './src/script.ts';
import { buildTimeline } from './src/timeline.ts';
import { cardValues, type HomeTruthResult } from './src/hometruth.ts';
import { HOMETRUTH_FILE, SCRIPT_FILE, TIMELINE_FILE, TTS_MANIFEST } from './src/paths.ts';
import type { TtsManifest } from './tts.ts';

function main(): void {
  if (!existsSync(TTS_MANIFEST)) throw new Error('out/tts/manifest.json is missing: run npm run video:tts first');
  const script = parseScript(readFileSync(SCRIPT_FILE, 'utf8'));
  const manifest = JSON.parse(readFileSync(TTS_MANIFEST, 'utf8')) as TtsManifest;
  const hometruth = existsSync(HOMETRUTH_FILE) ? cardValues(JSON.parse(readFileSync(HOMETRUTH_FILE, 'utf8')) as HomeTruthResult) : {};
  const tl = buildTimeline(script, manifest.clips, hometruth);
  writeFileSync(TIMELINE_FILE, JSON.stringify(tl, null, 2));
  const mmss = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  for (const b of tl.beats) console.log(`${mmss(b.start)}  ${(b.end - b.start).toFixed(1).padStart(5)}s  ${b.id}`);
  const pending = tl.placeholders.filter((p) => p.value === null).length;
  console.log(`timeline: ${mmss(tl.duration)} (${tl.duration}s, ${tl.frames} frames), ${tl.audio.length} clips, ${tl.actions.length} actions, ${pending} benchmark placeholders shown as "benchmark running"`);
  if (tl.duration > tl.maxSeconds) {
    console.error(`too long: ${tl.duration}s is over the script's MAX ${tl.maxSeconds}s`);
    process.exit(1);
  }
}

main();
