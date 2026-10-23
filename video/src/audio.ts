// WAV helpers and the narration mix. Pure functions over Float32Array; file I/O stays in the callers.

export interface Pcm {
  sampleRate: number;
  samples: Float32Array; // mono
}

/** Reads a mono or stereo WAV (PCM 16 bit or IEEE float 32 bit) into mono float samples. */
export function decodeWav(buf: Uint8Array): Pcm {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number): string => String.fromCharCode(buf[o] ?? 0, buf[o + 1] ?? 0, buf[o + 2] ?? 0, buf[o + 3] ?? 0);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt');
      const { format, channels, rate, bits } = fmt;
      const bytes = bits / 8;
      const frames = Math.floor(Math.min(size, buf.length - body) / (bytes * channels));
      const samples = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) {
          const p = body + (f * channels + c) * bytes;
          if (format === 3 && bits === 32) acc += dv.getFloat32(p, true);
          else if (format === 1 && bits === 16) acc += dv.getInt16(p, true) / 32768;
          else throw new Error(`unsupported WAV format ${format}/${bits}`);
        }
        samples[f] = acc / channels;
      }
      return { sampleRate: rate, samples };
    }
    o = body + size + (size % 2);
  }
  throw new Error('WAV without data chunk');
}

export function encodeWav(pcm: Pcm): Uint8Array {
  const n = pcm.samples.length;
  const out = new Uint8Array(44 + n * 4);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  put(0, 'RIFF');
  dv.setUint32(4, 36 + n * 4, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, pcm.sampleRate, true);
  dv.setUint32(28, pcm.sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 32, true);
  put(36, 'data');
  dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) dv.setFloat32(44 + i * 4, pcm.samples[i] as number, true);
  return out;
}

/**
 * Cuts leading and trailing silence (below `threshold` amplitude, about -50 dBFS by default) and keeps a
 * short margin, so the timeline measures speech rather than padding.
 */
export function trimSilence(pcm: Pcm, threshold = 0.003, marginSec = 0.04): Pcm {
  const s = pcm.samples;
  let a = 0;
  while (a < s.length && Math.abs(s[a] as number) < threshold) a++;
  let b = s.length - 1;
  while (b > a && Math.abs(s[b] as number) < threshold) b--;
  if (a >= s.length) return { sampleRate: pcm.sampleRate, samples: new Float32Array(0) };
  const m = Math.round(marginSec * pcm.sampleRate);
  return { sampleRate: pcm.sampleRate, samples: s.slice(Math.max(0, a - m), Math.min(s.length, b + 1 + m)) };
}

export function rmsDb(samples: Float32Array, from = 0, to = samples.length): number {
  let acc = 0;
  const n = Math.max(0, Math.min(to, samples.length) - Math.max(0, from));
  if (!n) return -Infinity;
  for (let i = Math.max(0, from); i < Math.min(to, samples.length); i++) acc += (samples[i] as number) ** 2;
  return 10 * Math.log10(acc / n + 1e-20);
}

export function peak(samples: Float32Array): number {
  let p = 0;
  for (const v of samples) p = Math.max(p, Math.abs(v));
  return p;
}

/** The peak never passes `ceiling`, even when that leaves the clip below `targetDb`. */
export function levelGain(samples: Float32Array, targetDb: number, ceiling = 0.89): number {
  const now = rmsDb(samples);
  if (!Number.isFinite(now)) return 1;
  const g = 10 ** ((targetDb - now) / 20);
  const p = peak(samples);
  return p > 0 ? Math.min(g, ceiling / p) : g;
}

export interface Placement {
  start: number; // seconds
  pcm: Pcm;
  gain: number;
}

/** Clips must already be at `sampleRate`. */
export function mix(placements: Placement[], duration: number, sampleRate: number): Pcm {
  const out = new Float32Array(Math.ceil(duration * sampleRate));
  for (const p of placements) {
    if (p.pcm.sampleRate !== sampleRate) throw new Error(`clip at ${p.start}s has rate ${p.pcm.sampleRate}, mix is ${sampleRate}`);
    const at = Math.round(p.start * sampleRate);
    const s = p.pcm.samples;
    for (let i = 0; i < s.length && at + i < out.length; i++) {
      if (at + i >= 0) out[at + i] = (out[at + i] as number) + (s[i] as number) * p.gain;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] as number));
  return { sampleRate, samples: out };
}
