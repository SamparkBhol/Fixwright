// npm run video:tts. Renders every sentence of script.txt with Kokoro (fp32 on the CPU, one sentence per
// call), trims the silence around it, and writes out/tts/<clip id>.wav plus out/tts/manifest.json with the
// measured length of each clip. Clips already rendered with the same voice, speed and text are kept.
//
// Env: FIXWRIGHT_TTS_THREADS (default 4: the CPU is shared with the benchmark run), FIXWRIGHT_TTS_CACHE.

import { env as hfEnv, StyleTextToSpeech2Model, AutoTokenizer } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipRequests, parseScript, type Role } from './src/script.ts';
import { decodeWav, encodeWav, peak, rmsDb, trimSilence } from './src/audio.ts';
import { MODEL_CACHE, SCRIPT_FILE, TTS_DIR, TTS_MANIFEST } from './src/paths.ts';

export interface ClipInfo {
  role: Role;
  voice: string;
  speed: number;
  text: string;
  file: string; // relative to out/tts
  sec: number; // trimmed length
  rawSec: number;
  genSec: number;
  rmsDb: number;
  peak: number;
}

export interface TtsManifest {
  model: string;
  dtype: string;
  threads: number;
  sampleRate: number;
  clips: Record<string, ClipInfo>;
  run: { loadSec: number; generated: number; reused: number; audioSec: number; genSec: number; rtf: number | null; wallSec: number };
}

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE = 'fp32';

async function main(): Promise<void> {
  const t0 = performance.now();
  const threads = Number(process.env['FIXWRIGHT_TTS_THREADS'] ?? 4);
  const script = parseScript(readFileSync(SCRIPT_FILE, 'utf8'));
  const wanted = clipRequests(script);
  mkdirSync(TTS_DIR, { recursive: true });
  const old: TtsManifest | null = existsSync(TTS_MANIFEST) ? (JSON.parse(readFileSync(TTS_MANIFEST, 'utf8')) as TtsManifest) : null;

  const clips: Record<string, ClipInfo> = {};
  const todo = wanted.filter((c) => {
    const prev = old?.clips[c.id];
    if (prev && prev.text === c.text && prev.voice === c.voice && prev.speed === c.speed && existsSync(join(TTS_DIR, prev.file))) {
      clips[c.id] = prev;
      return false;
    }
    return true;
  });

  let loadSec = 0;
  let genTotal = 0;
  let audioTotal = 0;
  let sampleRate = old?.sampleRate ?? 24000;
  if (todo.length) {
    hfEnv.cacheDir = MODEL_CACHE;
    mkdirSync(MODEL_CACHE, { recursive: true });
    const l0 = performance.now();
    // Built by hand (not KokoroTTS.from_pretrained) so the ONNX thread count is explicit: onnxruntime-node
    // otherwise pins threads to CPU ids 0..N-1, which fails in this container's cpuset.
    const [model, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(MODEL, { dtype: DTYPE, device: 'cpu', session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } }),
      AutoTokenizer.from_pretrained(MODEL),
    ]);
    const tts = new KokoroTTS(model, tokenizer);
    await tts.generate('Warm up.', { voice: 'af_heart' });
    loadSec = (performance.now() - l0) / 1000;
    for (const c of todo) {
      const g0 = performance.now();
      const audio = await tts.generate(c.text, { voice: c.voice as 'af_heart', speed: c.speed });
      const genSec = (performance.now() - g0) / 1000;
      sampleRate = audio.sampling_rate;
      const raw = { sampleRate: audio.sampling_rate, samples: audio.audio };
      const trimmed = trimSilence(raw);
      const file = `${c.id}.wav`;
      writeFileSync(join(TTS_DIR, file), encodeWav(trimmed));
      const sec = trimmed.samples.length / trimmed.sampleRate;
      clips[c.id] = {
        role: c.role,
        voice: c.voice,
        speed: c.speed,
        text: c.text,
        file,
        sec: +sec.toFixed(3),
        rawSec: +(raw.samples.length / raw.sampleRate).toFixed(3),
        genSec: +genSec.toFixed(3),
        rmsDb: +rmsDb(trimmed.samples).toFixed(2),
        peak: +peak(trimmed.samples).toFixed(4),
      };
      genTotal += genSec;
      audioTotal += sec;
      console.log(`tts ${c.role.padEnd(8)} ${sec.toFixed(2)}s in ${genSec.toFixed(2)}s  ${c.text.slice(0, 70)}`);
    }
  }
  // A clip whose file was lost is caught by the existsSync check above; decodeWav sanity checks the rest.
  for (const [id, c] of Object.entries(clips)) {
    const pcm = decodeWav(readFileSync(join(TTS_DIR, c.file)));
    if (Math.abs(pcm.samples.length / pcm.sampleRate - c.sec) > 0.01) throw new Error(`clip ${id} length changed on disk`);
  }
  const manifest: TtsManifest = {
    model: MODEL,
    dtype: DTYPE,
    threads,
    sampleRate,
    clips,
    run: {
      loadSec: +loadSec.toFixed(3),
      generated: todo.length,
      reused: wanted.length - todo.length,
      audioSec: +audioTotal.toFixed(3),
      genSec: +genTotal.toFixed(3),
      rtf: audioTotal ? +(genTotal / audioTotal).toFixed(4) : null,
      wallSec: +((performance.now() - t0) / 1000).toFixed(3),
    },
  };
  writeFileSync(TTS_MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`tts done: ${wanted.length} clips (${todo.length} new, ${manifest.run.reused} reused), ${manifest.run.wallSec}s wall, rtf ${manifest.run.rtf}`);
}

await main();
