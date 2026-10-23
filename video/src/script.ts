// Parser for video/script.txt (one instruction per line, keyword first). Pure: text in, Script out.

export type Role = 'narrator' | 'user' | 'reply';
export const ROLES: readonly Role[] = ['narrator', 'user', 'reply'];

export interface Voice {
  voice: string;
  speed: number;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpeechLine {
  role: Role;
  /** What the screen and the captions show. */
  text: string;
  /** What the voice says (the text after "||", else the text). */
  spoken: string;
  /** The spoken text, one sentence per TTS call (empty for a SHOWN reply, which is on screen only). */
  sentences: string[];
  voiced: boolean;
}

export type CardItem =
  | { kind: 'title' | 'sub' | 'line' | 'foot' | 'close'; text: string }
  | { kind: 'head' | 'row'; cells: string[] }
  | { kind: 'item'; group: string; text: string }
  | { kind: 'terminal' };

export type StepBody =
  | { kind: 'speech'; line: SpeechLine }
  | { kind: 'do'; verb: 'click'; selector: string; name: string }
  | { kind: 'do'; verb: 'open-trace'; tool: string }
  | { kind: 'do'; verb: 'device'; device: string }
  | { kind: 'do'; verb: 'hold' }
  | { kind: 'do'; verb: 'trace-top' }
  | { kind: 'do'; verb: 'replay'; sentence: number; seconds: number }
  | { kind: 'pause'; seconds: number | 'read' }
  | { kind: 'label'; text: string | null }
  | { kind: 'camera'; region: string; seconds?: number }
  | { kind: 'item'; item: CardItem };

export type Step = StepBody & { with: boolean; srcLine: number };

export type Scene = { kind: 'host' } | { kind: 'card'; card: string };

export interface Beat {
  id: string;
  title: string;
  scene: Scene;
  steps: Step[];
}

export interface Script {
  voices: Record<Role, Voice>;
  maxSeconds: number;
  regions: Record<string, Region>;
  beats: Beat[];
}

/** A plain Error named 'ScriptError', so callers tell it apart by name instead of by class. */
export function scriptError(message: string): Error {
  const e = new Error(message);
  e.name = 'ScriptError';
  return e;
}

const DEVICES = ['large', 'small', 'phone', 'voice'];
const CARDS = ['open', 'title', 'bench', 'terminal', 'slate'];

/** Splits spoken text into sentences for one TTS call each (kokoro-js truncates long inputs silently). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    cur = cur ? `${cur} ${w}` : w;
    const next = words[i + 1];
    if (/[.!?]["')]?$/.test(w) && (next === undefined || /^["'(]?[A-Z0-9]/.test(next))) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function speech(role: Role, rest: string, voiced = true): SpeechLine {
  const [shown, said] = rest.split('||').map((s) => s.trim());
  const text = shown ?? '';
  const spoken = said || text;
  if (!text) throw scriptError(`${role} line is empty`);
  return { role, text, spoken, sentences: voiced ? splitSentences(spoken) : [], voiced };
}

const cells = (rest: string): string[] => rest.split('|').map((s) => s.trim());

function parseItem(kw: string, rest: string): CardItem {
  switch (kw) {
    case 'TITLE':
    case 'SUB':
    case 'LINE':
    case 'FOOT':
    case 'CLOSE':
      if (!rest) throw scriptError(`${kw} needs text`);
      return { kind: kw.toLowerCase() as 'title' | 'sub' | 'line' | 'foot' | 'close', text: rest };
    case 'HEAD':
    case 'ROW':
      return { kind: kw === 'HEAD' ? 'head' : 'row', cells: cells(rest) };
    case 'ITEM': {
      const [group, text] = cells(rest);
      if (!group || !text) throw scriptError('ITEM needs "group | text"');
      return { kind: 'item', group, text };
    }
    case 'TERMINAL':
      return { kind: 'terminal' };
    default:
      throw scriptError(`unknown card item ${kw}`);
  }
}

const ITEM_KEYWORDS = new Set(['TITLE', 'SUB', 'LINE', 'FOOT', 'CLOSE', 'HEAD', 'ROW', 'ITEM', 'TERMINAL']);

function parseStep(kw: string, rest: string, regions: Record<string, Region>): StepBody {
  switch (kw) {
    case 'NARRATOR':
      return { kind: 'speech', line: speech('narrator', rest) };
    case 'USER':
      return { kind: 'speech', line: speech('user', rest) };
    case 'REPLY':
      return { kind: 'speech', line: speech('reply', rest) };
    case 'SHOWN':
      return { kind: 'speech', line: speech('reply', rest, false) };
    case 'DO': {
      const [verb, ...args] = rest.split(/\s+/);
      if (verb === 'device') {
        const device = args[0] ?? '';
        if (!DEVICES.includes(device)) throw scriptError(`DO device needs one of ${DEVICES.join(', ')}`);
        return { kind: 'do', verb: 'device', device };
      }
      if (verb === 'hold') return { kind: 'do', verb: 'hold' };
      if (verb === 'trace-top') return { kind: 'do', verb: 'trace-top' };
      if (verb === 'replay') {
        const [sentence, seconds] = args.map(Number);
        if (!Number.isInteger(sentence) || (sentence as number) < 1 || !Number.isFinite(seconds) || (seconds as number) <= 0 || (seconds as number) > 10) {
          throw scriptError('DO replay needs "sentence seconds", for example DO replay 2 2.6');
        }
        return { kind: 'do', verb: 'replay', sentence: sentence as number, seconds: seconds as number };
      }
      if (verb === 'open-trace') {
        if (!args[0]) throw scriptError('DO open-trace needs a tool name');
        return { kind: 'do', verb: 'open-trace', tool: args[0] };
      }
      if (verb === 'click') {
        const m = /^click\s+(\S+)\s*(.*)$/.exec(rest);
        if (!m) throw scriptError('DO click needs a selector');
        return { kind: 'do', verb: 'click', selector: m[1] as string, name: (m[2] ?? '').trim() };
      }
      throw scriptError(`unknown DO verb ${verb}`);
    }
    case 'PAUSE': {
      if (rest === 'read') return { kind: 'pause', seconds: 'read' };
      const s = Number(rest);
      if (!Number.isFinite(s) || s < 0 || s > 10) throw scriptError(`PAUSE needs seconds (0 to 10) or read, got "${rest}"`);
      return { kind: 'pause', seconds: s };
    }
    case 'LABEL':
      if (!rest) throw scriptError('LABEL needs text or off');
      return { kind: 'label', text: rest === 'off' ? null : rest };
    case 'CAMERA': {
      const [region = '', secs] = rest.split(/\s+/);
      if (region !== 'full' && !regions[region]) throw scriptError(`unknown camera region ${region}`);
      if (secs === undefined) return { kind: 'camera', region };
      const seconds = Number(secs);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10) throw scriptError(`CAMERA move needs seconds (up to 10), got "${secs}"`);
      return { kind: 'camera', region, seconds };
    }
    default:
      if (ITEM_KEYWORDS.has(kw)) return { kind: 'item', item: parseItem(kw, rest) };
      throw scriptError(`unknown keyword ${kw}`);
  }
}

export function parseScript(src: string): Script {
  const voices: Partial<Record<Role, Voice>> = {};
  const regions: Record<string, Region> = {};
  const beats: Beat[] = [];
  let maxSeconds = 175;
  let beat: Beat | null = null;

  const lines = src.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith('NOTE')) return;
    try {
      let m = /^(\S+)\s*(.*)$/.exec(line) as RegExpExecArray;
      let kw = m[1] as string;
      let rest = (m[2] ?? '').trim();
      if (kw === 'VOICE') {
        const [role, voice, speed] = rest.split(/\s+/);
        if (!ROLES.includes(role as Role) || !voice) throw scriptError('VOICE needs "role voice [speed]"');
        voices[role as Role] = { voice, speed: speed ? Number(speed) : 1 };
        return;
      }
      if (kw === 'MAX') {
        maxSeconds = Number(rest);
        if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw scriptError('MAX needs seconds');
        return;
      }
      if (kw === 'REGION') {
        const [name, x, y, w] = rest.split(/\s+/);
        const nums = [x, y, w].map(Number);
        if (!name || nums.some((n) => !Number.isFinite(n))) throw scriptError('REGION needs "name x y width"');
        const [rx, ry, rw] = nums as [number, number, number];
        regions[name] = { x: rx, y: ry, w: rw, h: Math.round((rw * 9) / 16) };
        return;
      }
      if (kw === 'BEAT') {
        const [id, ...title] = rest.split(/\s+/);
        if (!id) throw scriptError('BEAT needs an id');
        if (beats.some((b) => b.id === id)) throw scriptError(`duplicate beat ${id}`);
        beat = { id, title: title.join(' '), scene: beat ? beat.scene : { kind: 'host' }, steps: [] };
        beats.push(beat);
        return;
      }
      if (!beat) throw scriptError(`${kw} before the first BEAT`);
      const current: Beat = beat;
      if (kw === 'SCENE') {
        if (current.steps.length) throw scriptError('SCENE must come first in a beat');
        const [kind, card] = rest.split(/\s+/);
        if (kind === 'host') current.scene = { kind: 'host' };
        else if (kind === 'card' && card && CARDS.includes(card)) current.scene = { kind: 'card', card };
        else throw scriptError(`SCENE needs host or card <${CARDS.join('|')}>`);
        return;
      }
      let withPrev = false;
      if (kw === 'WITH') {
        withPrev = true;
        m = /^(\S+)\s*(.*)$/.exec(rest) as RegExpExecArray;
        if (!m) throw scriptError('WITH needs a step');
        kw = m[1] as string;
        rest = (m[2] ?? '').trim();
      }
      const body = parseStep(kw, rest, regions);
      if (body.kind === 'item' && current.scene.kind !== 'card') throw scriptError(`${kw} only works on a card scene`);
      if (body.kind === 'do' && current.scene.kind !== 'host') throw scriptError('DO only works on the host scene');
      if (body.kind === 'speech' && body.line.role !== 'narrator' && current.scene.kind !== 'host') {
        throw scriptError('USER and REPLY only work on the host scene');
      }
      current.steps.push({ ...body, with: withPrev, srcLine: lineNo } as Step);
    } catch (e) {
      if (e instanceof Error && e.name === 'ScriptError') throw scriptError(`script.txt line ${lineNo}: ${e.message}`);
      throw e;
    }
  });

  for (const role of ROLES) if (!voices[role]) throw scriptError(`script.txt: missing VOICE ${role}`);
  if (!beats.length) throw scriptError('script.txt: no beats');
  return { voices: voices as Record<Role, Voice>, maxSeconds, regions, beats };
}

/** Every distinct sentence the TTS step must render, keyed by a stable clip id. */
export interface ClipRequest {
  id: string;
  role: Role;
  voice: string;
  speed: number;
  text: string;
}

/** FNV-1a, 32 bit, hex: a stable short id so clips survive edits elsewhere in the script. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function clipId(role: Role, v: Voice, sentence: string): string {
  return `${role}-${hash(`${v.voice}|${v.speed}|${sentence}`)}`;
}

export function clipRequests(script: Script): ClipRequest[] {
  const seen = new Map<string, ClipRequest>();
  for (const b of script.beats) {
    for (const s of b.steps) {
      if (s.kind !== 'speech') continue;
      const v = script.voices[s.line.role];
      for (const text of s.line.sentences) {
        const id = clipId(s.line.role, v, text);
        if (!seen.has(id)) seen.set(id, { id, role: s.line.role, voice: v.voice, speed: v.speed, text });
      }
    }
  }
  return [...seen.values()];
}
