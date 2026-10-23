// Every start time is the sum of measured clip lengths, the style gaps below and the settle time of on
// screen actions, never a fixed offset into the video.

import { clipId, splitSentences, wordCount, type Beat, type CardItem, type Region, type Role, type Scene, type Script } from './script.ts';

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const GAPS = {
  sentence: 0.14,
  step: 0.26,
  userToSend: 0.22,
  sendToReply: 0.3,
  beatTail: 0.25,
  cutLead: 0.3,
  cameraMove: 0.7,
  terminalHold: 1.0,
};

export const SETTLE = { device: 1.0, click: 0.9, 'open-trace': 0.9, hold: 0, replay: 0, 'trace-top': 0 } as const;

export const READ = { wordsPerSec: 4.2, min: 1.2, max: 6 };

export interface ClipLengths {
  [clipId: string]: { sec: number };
}

export interface TAudio {
  id: string;
  role: Role;
  start: number;
  dur: number;
  text: string;
  beat: string;
}

export interface TCaption {
  start: number;
  end: number;
  role: Role;
  text: string;
}

export type TAction =
  | { at: number; beat: string; kind: 'say'; text: string; expect: string | null }
  | { at: number; beat: string; kind: 'device'; device: string }
  | { at: number; beat: string; kind: 'click'; selector: string; name: string }
  | { at: number; beat: string; kind: 'open-trace'; tool: string }
  | { at: number; beat: string; kind: 'hold' }
  | { at: number; beat: string; kind: 'trace-top' }
  | { at: number; beat: string; kind: 'replay'; until: number }
  | { at: number; beat: string; kind: 'terminal' };

export interface TTyping {
  start: number;
  end: number;
  text: string;
}

export interface TLabel {
  start: number;
  end: number;
  text: string;
}

export interface TCamera {
  at: number;
  move: number;
  region: Region;
  name: string;
}

export interface TCardItem {
  at: number;
  until?: number;
  item: CardItem;
}

export interface TScene {
  beat: string;
  start: number;
  end: number;
  scene: Scene;
  items: TCardItem[];
}

export interface Timeline {
  fps: number;
  width: number;
  height: number;
  duration: number;
  frames: number;
  maxSeconds: number;
  beats: Array<{ id: string; title: string; start: number; end: number }>;
  scenes: TScene[];
  audio: TAudio[];
  captions: TCaption[];
  actions: TAction[];
  typing: TTyping[];
  labels: TLabel[];
  cameras: TCamera[];
  cuts: number[];
  placeholders: Array<{ key: string; value: string | null }>;
}

export const FULL: Region = { x: 0, y: 0, w: WIDTH, h: HEIGHT };

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export function readSeconds(text: string): number {
  return Math.min(READ.max, Math.max(READ.min, wordCount(text) / READ.wordsPerSec));
}

/** A key with no measured value renders as "benchmark running". */
export function resolvePlaceholders(
  text: string,
  values: Record<string, string>,
  seen: Map<string, string | null>,
): string {
  return text.replace(/\{\{HOMETRUTH:([a-z0-9_.]+)\}\}/gi, (_, key: string) => {
    const v = values[key];
    seen.set(key, v ?? null);
    return v ?? 'benchmark running';
  });
}

function resolveItem(item: CardItem, values: Record<string, string>, seen: Map<string, string | null>): CardItem {
  const r = (s: string): string => resolvePlaceholders(s, values, seen);
  switch (item.kind) {
    case 'head':
    case 'row':
      return { ...item, cells: item.cells.map(r) };
    case 'item':
      return { ...item, group: r(item.group), text: r(item.text) };
    case 'terminal':
      return item;
    default:
      return { ...item, text: r(item.text) };
  }
}

function itemText(item: CardItem): string {
  switch (item.kind) {
    case 'head':
    case 'row':
      return item.cells.join(' ');
    case 'item':
      return item.text;
    case 'terminal':
      return '';
    default:
      return item.text;
  }
}

/** The next REPLY in the beat after step i, before any other USER line: what the live server must say. */
function expectedReply(beat: Beat, i: number): string | null {
  for (let j = i + 1; j < beat.steps.length; j++) {
    const s = beat.steps[j];
    if (s?.kind !== 'speech') continue;
    if (s.line.role === 'user') return null;
    if (s.line.role === 'reply') return s.line.text;
  }
  return null;
}

/** Captions follow the screen text; when its sentences line up with the spoken ones, one caption each. */
function captionTexts(text: string, spokenSentences: string[]): string[] | null {
  const shown = splitSentences(text);
  return shown.length === spokenSentences.length ? shown : null;
}

export function buildTimeline(script: Script, lengths: ClipLengths, hometruth: Record<string, string> = {}): Timeline {
  const audio: TAudio[] = [];
  const captions: TCaption[] = [];
  const actions: TAction[] = [];
  const typing: TTyping[] = [];
  const labels: TLabel[] = [];
  const cameras: TCamera[] = [];
  const scenes: TScene[] = [];
  const beats: Timeline['beats'] = [];
  const cuts: number[] = [];
  const seen = new Map<string, string | null>();

  const clipSec = (role: Role, sentence: string): { id: string; sec: number } => {
    const id = clipId(role, script.voices[role], sentence);
    const c = lengths[id];
    if (!c) throw new Error(`no measured clip for ${role} "${sentence}" (run npm run video:tts)`);
    return { id, sec: c.sec };
  };

  let t = 0;
  let prevScene: Scene | null = null;
  let cameraBusyUntil = 0;
  for (const beat of script.beats) {
    const beatStart = t;
    const sceneRow: TScene = { beat: beat.id, start: beatStart, end: beatStart, scene: beat.scene, items: [] };
    const isCut = !!prevScene && JSON.stringify(prevScene) !== JSON.stringify(beat.scene);
    if (isCut) cuts.push(r3(beatStart));
    prevScene = beat.scene;
    let cursor = t + (isCut ? GAPS.cutLead : 0);
    let prevStart = cursor;
    let lastText = '';
    let openLabel: { start: number; text: string } | null = null;
    let readSince: string[] = [];
    let sentenceStarts: number[] = [];
    const terminalItems: TCardItem[] = [];

    beat.steps.forEach((step, i) => {
      // A click waits for a camera move to finish, so the tap lands where the viewer sees the button.
      const replayAt = step.kind === 'do' && step.verb === 'replay' ? sentenceStarts[step.sentence - 1] : undefined;
      const start = replayAt ?? Math.max(step.with ? prevStart : cursor, step.kind === 'do' && step.verb !== 'hold' ? cameraBusyUntil : 0);
      let end = start;
      switch (step.kind) {
        case 'speech': {
          const { line } = step;
          let at = start;
          const parts = line.sentences.map((s) => clipSec(line.role, s));
          const capTexts = captionTexts(line.text, line.sentences);
          const lineStart = at;
          sentenceStarts = [];
          parts.forEach((p, k) => {
            sentenceStarts.push(at);
            audio.push({ id: p.id, role: line.role, start: r3(at), dur: p.sec, text: line.sentences[k] as string, beat: beat.id });
            if (line.role === 'narrator' && capTexts) captions.push({ start: r3(at), end: r3(at + p.sec), role: line.role, text: capTexts[k] as string });
            at += p.sec + (k < parts.length - 1 ? GAPS.sentence : 0);
          });
          if (line.role === 'narrator' && !capTexts && parts.length) captions.push({ start: r3(lineStart), end: r3(at), role: line.role, text: line.text });
          if (line.role === 'user') {
            typing.push({ start: r3(lineStart), end: r3(at), text: line.text });
            const send = at + GAPS.userToSend;
            actions.push({ at: r3(send), beat: beat.id, kind: 'say', text: line.text, expect: expectedReply(beat, i) });
            end = send + GAPS.sendToReply;
          } else {
            end = line.voiced ? at + GAPS.step : at;
          }
          if (line.role === 'reply') lastText = line.text;
          break;
        }
        case 'do': {
          if (step.verb === 'device') actions.push({ at: r3(start), beat: beat.id, kind: 'device', device: step.device });
          else if (step.verb === 'click') actions.push({ at: r3(start), beat: beat.id, kind: 'click', selector: step.selector, name: step.name });
          else if (step.verb === 'hold') actions.push({ at: r3(start), beat: beat.id, kind: 'hold' });
          else if (step.verb === 'trace-top') actions.push({ at: r3(start), beat: beat.id, kind: 'trace-top' });
          else if (step.verb === 'replay') {
            if (replayAt === undefined) throw new Error(`beat ${beat.id}: DO replay ${step.sentence} has no spoken sentence ${step.sentence} before it`);
            actions.push({ at: r3(start), beat: beat.id, kind: 'replay', until: r3(start + step.seconds) });
          } else actions.push({ at: r3(start), beat: beat.id, kind: 'open-trace', tool: step.tool });
          end = start + SETTLE[step.verb];
          break;
        }
        case 'pause': {
          const text = beat.scene.kind === 'card' ? readSince.join(' ') : lastText;
          end = start + (step.seconds === 'read' ? readSeconds(text) : step.seconds);
          if (step.seconds === 'read') readSince = [];
          break;
        }
        case 'label': {
          if (openLabel) labels.push({ start: r3(openLabel.start), end: r3(start), text: openLabel.text });
          openLabel = step.text ? { start, text: step.text } : null;
          if (step.text) lastText = step.text;
          break;
        }
        case 'camera': {
          const region = step.region === 'full' ? FULL : (script.regions[step.region] as Region);
          const move = step.seconds ?? GAPS.cameraMove;
          cameras.push({ at: r3(start), move, region, name: step.region });
          cameraBusyUntil = start + move;
          break;
        }
        case 'item': {
          const item = resolveItem(step.item, hometruth, seen);
          const row: TCardItem = { at: r3(start), item };
          sceneRow.items.push(row);
          if (item.kind === 'terminal') {
            terminalItems.push(row);
            actions.push({ at: r3(start), beat: beat.id, kind: 'terminal' });
          }
          readSince.push(itemText(item));
          break;
        }
      }
      if (!(step.kind === 'do' && step.verb === 'replay')) prevStart = start;
      cursor = Math.max(cursor, step.kind === 'do' && step.verb === 'replay' ? cursor : end);
    });

    const beatEnd = cursor + GAPS.beatTail;
    if (openLabel) labels.push({ start: r3((openLabel as { start: number }).start), end: r3(beatEnd), text: (openLabel as { text: string }).text });
    for (const row of terminalItems) row.until = r3(Math.max(row.at + 1, beatEnd - GAPS.terminalHold));
    sceneRow.end = r3(beatEnd);
    scenes.push(sceneRow);
    beats.push({ id: beat.id, title: beat.title, start: r3(beatStart), end: r3(beatEnd) });
    t = beatEnd;
  }

  const duration = r3(t);
  return {
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    duration,
    frames: Math.ceil(duration * FPS),
    maxSeconds: script.maxSeconds,
    beats,
    scenes,
    audio,
    captions,
    actions,
    typing,
    labels,
    cameras,
    cuts,
    placeholders: [...seen.entries()].map(([key, value]) => ({ key, value })),
  };
}

export function cameraAt(cams: TCamera[], t: number): Region {
  let base = FULL; // where the active move started
  let active: TCamera | null = null;
  for (const c of cams) {
    if (c.at > t) break;
    if (active) base = moveAt(base, active, c.at);
    active = c;
  }
  return active ? moveAt(base, active, t) : FULL;
}

function moveAt(from: Region, c: TCamera, t: number): Region {
  const p = Math.min(1, Math.max(0, (t - c.at) / c.move));
  const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
  return {
    x: from.x + (c.region.x - from.x) * e,
    y: from.y + (c.region.y - from.y) * e,
    w: from.w + (c.region.w - from.w) * e,
    h: from.h + (c.region.h - from.h) * e,
  };
}

export function sceneAt(tl: Pick<Timeline, 'scenes'>, t: number): TScene {
  for (const s of tl.scenes) if (t < s.end) return s;
  return tl.scenes[tl.scenes.length - 1] as TScene;
}
