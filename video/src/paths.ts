// Where the pipeline reads and writes. Everything stays inside video/ (out/ and .cache/ are git ignored).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const VIDEO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const SCRIPT_FILE = join(VIDEO_DIR, 'script.txt');
export const OUT_DIR = join(VIDEO_DIR, 'out');
export const TTS_DIR = join(OUT_DIR, 'tts');
export const TTS_MANIFEST = join(TTS_DIR, 'manifest.json');
export const TIMELINE_FILE = join(OUT_DIR, 'timeline.json');
export const RECORD_FILE = join(OUT_DIR, 'record.json');
export const FRAMES_FILE = join(OUT_DIR, 'frames.mp4');
export const MIX_FILE = join(OUT_DIR, 'mix.wav');
export const ASS_FILE = join(OUT_DIR, 'captions.ass');
export const FINAL_FILE = join(OUT_DIR, 'fixwright-demo.mp4');
export const CONTACT_SHEET = join(OUT_DIR, 'contact-sheet.png');
export const VERIFY_FILE = join(OUT_DIR, 'verify.json');
export const CARDS_HTML = join(VIDEO_DIR, 'cards', 'cards.html');
export const FONTS_DIR = join(VIDEO_DIR, 'fonts');
export const MODEL_CACHE = process.env['FIXWRIGHT_TTS_CACHE'] ?? join(VIDEO_DIR, '.cache', 'transformers');
export const REPO_DIR = dirname(VIDEO_DIR);
/** The HomeTruth run the benchmark card reads: the held out sample with both LLM baselines. */
export const HOMETRUTH_FILE = process.env['FIXWRIGHT_HOMETRUTH'] ?? join(REPO_DIR, 'bench', 'results', 'hometruth-heldout-b1b2-n100.json');
