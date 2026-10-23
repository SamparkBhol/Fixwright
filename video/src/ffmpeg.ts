// ffmpeg-static helpers (there is no ffprobe in ffmpeg-static: probe with "ffmpeg -i" and decode to null).

import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

export const FFMPEG = ffmpegStatic as unknown as string;

export interface RunResult {
  code: number;
  stderr: string;
  stdout: Buffer;
}

export function ffmpeg(args: string[], opts: { cwd?: string; stdin?: Buffer } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args], { cwd: opts.cwd, stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout?.on('data', (d: Buffer) => out.push(d));
    p.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 2_000_000) err = err.slice(-1_000_000);
    });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stderr: err, stdout: Buffer.concat(out) }));
    if (opts.stdin && p.stdin) p.stdin.end(opts.stdin);
  });
}

export async function ffmpegOk(args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  const r = await ffmpeg(args, opts);
  if (r.code !== 0) throw new Error(`ffmpeg ${args.slice(0, 6).join(' ')} ... exit ${r.code}: ${r.stderr.slice(-1500)}`);
  return r;
}

export interface FrameEncoder {
  write(jpeg: Buffer): Promise<void>;
  end(): Promise<void>;
}

/** A high quality intermediate; compose encodes the final file. */
export function jpegEncoder(outFile: string, fps: number): FrameEncoder {
  const p = spawn(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(fps), outFile],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let err = '';
  p.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const done = new Promise<void>((res, rej) => p.on('close', (c) => (c === 0 ? res() : rej(new Error(`encoder exit ${c}: ${err}`)))));
  return {
    write: (buf) => new Promise<void>((res) => (p.stdin.write(buf) ? res() : p.stdin.once('drain', () => res()))),
    end: async () => {
      p.stdin.end();
      await done;
    },
  };
}

export interface Probe {
  duration: number | null;
  video: { codec: string; profile: string | null; pixFmt: string | null; width: number; height: number; fps: number | null } | null;
  audio: { codec: string; rate: number; channels: string } | null;
  raw: string;
}

/** Parses the stream header that "ffmpeg -i file" prints. */
export function parseProbe(text: string): Probe {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const vLine = /Stream #\d+:\d+[^\n]*: Video: [^\n]*/.exec(text)?.[0] ?? '';
  const vc = /Video: (\w+)(?: \(([^)]+)\))?/.exec(vLine);
  const vf = /, (yuv\w+|rgb\w+|nv12|gray\w*)/.exec(vLine);
  const vs = /, (\d{2,5})x(\d{2,5})/.exec(vLine);
  const vr = /, ([\d.]+) fps/.exec(vLine);
  const v = vc && vs ? { codec: vc[1] as string, profile: vc[2] ?? null, pixFmt: vf?.[1] ?? null, width: Number(vs[1]), height: Number(vs[2]), fps: vr ? Number(vr[1]) : null } : null;
  const a = /Stream #\d+:\d+[^:]*: Audio: (\w+)[^,]*, (\d+) Hz, (\w+)/.exec(text);
  return {
    duration,
    video: v,
    audio: a ? { codec: a[1] as string, rate: Number(a[2]), channels: a[3] as string } : null,
    raw: text.split('\n').filter((l) => /Duration|Stream/.test(l)).join('\n'),
  };
}

export async function probe(file: string): Promise<Probe> {
  const r = await ffmpeg(['-i', file]);
  return parseProbe(r.stderr);
}
