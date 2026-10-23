// The burned in overlay as an ASS file for libass: narrator captions, the labels that mark simulated parts,
// the standing honesty tag on host scenes, tap rings where the director clicked, and a dip at scene changes.
// Colors are the host stage's tokens; lamplight is never used here, nothing is lit.

import { cameraAt, type Timeline } from './timeline.ts';

export interface Tap {
  at: number;
  x: number;
  y: number;
}

export const CAPTION_BAND = { x: 260, y: 900, w: 1400, h: 160 };

const INK = '#1C2228';
const PAPER = '#EEF2F1';
const FONT = 'Atkinson Hyperlegible Next';
const FONT_MEDIUM = 'Atkinson Hyperlegible Next Medium';
const RING = 34;

/** ASS colours are &HAABBGGRR. */
export function assColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`bad colour ${hex}`);
  const a = alpha.toString(16).padStart(2, '0').toUpperCase();
  return `&H${a}${(m[3] as string).toUpperCase()}${(m[2] as string).toUpperCase()}${(m[1] as string).toUpperCase()}`;
}

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Braces start override blocks and backslashes start tags, so neither may reach libass as text. */
export function assText(s: string): string {
  return s.replace(/\\/g, '⧵').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');
}

function pack(words: string[], width: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Wraps to at most `max` characters per line in as few lines as a greedy wrap needs, with the lines as even
 * as possible, so no line ends up holding one orphan word. Joined with the ASS hard break.
 */
export function wrap(text: string, max: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = pack(words, max);
  let best = lines;
  for (let width = max - 1; width > 0 && lines.length > 1; width--) {
    const tried = pack(words, width);
    if (tried.length > lines.length || tried.some((l) => l.length > width && !l.includes(' '))) break;
    best = tried;
  }
  return best.map(assText).join('\\N');
}

function ring(r: number): string {
  const k = Math.round(r * 0.5523);
  const d = 2 * r;
  return `m ${r} 0 b ${r + k} 0 ${d} ${r - k} ${d} ${r} b ${d} ${r + k} ${r + k} ${d} ${r} ${d} b ${r - k} ${d} 0 ${r + k} 0 ${r} b 0 ${r - k} ${r - k} 0 ${r} 0`;
}

export function buildAss(tl: Timeline, taps: Tap[]): string {
  const ev: string[] = [];
  const dlg = (layer: number, start: number, end: number, style: string, text: string): void => {
    if (end - start < 0.02) return;
    ev.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`);
  };

  for (const c of tl.captions) dlg(2, c.start, c.end, 'Caption', wrap(c.text, 52));

  for (const s of tl.scenes) {
    if (s.scene.kind !== 'host') continue;
    dlg(1, s.start, s.end, 'Tag', `{\\an3\\pos(1892,1052)}Alexa+ host simulated\\NVoices: open source text to speech, not Alexa`);
  }

  for (const l of tl.labels) dlg(3, l.start, l.end, 'Label', `{\\an7\\pos(36,36)\\fad(200,200)}${wrap(l.text, 34)}`);

  for (const tap of taps) {
    const cam = cameraAt(tl.cameras, tap.at);
    const k = tl.width / cam.w;
    const x = Math.round((tap.x - cam.x) * k);
    const y = Math.round((tap.y - cam.y) * k);
    if (x < 0 || y < 0 || x > tl.width || y > tl.height) continue;
    dlg(4, tap.at, tap.at + 0.6, 'Tap', `{\\an7\\pos(${x - RING},${y - RING})\\fad(0,380)\\p1}${ring(RING)}{\\p0}`);
  }

  for (const cut of tl.cuts) {
    dlg(9, cut - 0.22, cut + 0.22, 'Dip', `{\\an7\\pos(0,0)\\fad(220,220)\\p1}m 0 0 l ${tl.width} 0 ${tl.width} ${tl.height} 0 ${tl.height}{\\p0}`);
  }

  // BorderStyle 4 draws one box behind the whole event in the back colour, padded by the outline width.
  const style = (name: string, font: string, size: number, primary: string, box: string, borderStyle: number, outlineW: number, align: number, ml: number, mr: number, mv: number): string =>
    `Style: ${name},${font},${size},${primary},${primary},${box},${box},0,0,0,0,100,100,0,0,${borderStyle},${outlineW},0,${align},${ml},${mr},${mv},1`;

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${tl.width}`,
    `PlayResY: ${tl.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Caption', FONT_MEDIUM, 46, assColor(PAPER), assColor(INK, 0x10), 4, 16, 2, CAPTION_BAND.x, CAPTION_BAND.x, 44),
    style('Tag', FONT, 22, assColor(INK), assColor(PAPER, 0x08), 4, 10, 3, 28, 28, 28),
    style('Label', FONT_MEDIUM, 28, assColor(INK), assColor(PAPER, 0x00), 4, 14, 7, 36, 36, 36),
    `Style: Tap,${FONT},20,&HFF000000,&HFF000000,${assColor(INK)},&H00000000,0,0,0,0,100,100,0,0,1,5,0,7,0,0,0,1`,
    style('Dip', FONT, 20, assColor(INK), assColor(INK), 1, 0, 7, 0, 0, 0),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...ev,
    '',
  ].join('\n');
}
