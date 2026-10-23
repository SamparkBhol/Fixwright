import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { clipId, clipRequests, parseScript, splitSentences } from '../src/script.ts';
import { buildTimeline, cameraAt, FULL, GAPS, readSeconds, resolvePlaceholders, sceneAt, type ClipLengths } from '../src/timeline.ts';
import { assColor, assTime, buildAss, wrap } from '../src/ass.ts';
import { decodeWav, encodeWav, levelGain, mix, rmsDb, trimSilence } from '../src/audio.ts';
import { cut, maskToken, parseRpcBody } from '../src/plain-mcp.ts';
import { parseProbe } from '../src/ffmpeg.ts';
import { HOMETRUTH_FILE, SCRIPT_FILE } from '../src/paths.ts';
import { cardValues, type HomeTruthResult } from '../src/hometruth.ts';
import { findMarks, findNonEnglish, findStandards } from '../src/marks.ts';
import { existsSync } from 'node:fs';

const MINI = `
NOTE a tiny script
VOICE narrator af_heart 1
VOICE user am_michael 1
VOICE reply bm_george 1
MAX 60
REGION device 150 112 1140

BEAT open Opening
SCENE card open
TITLE One. Two.
PAUSE read
NARRATOR First sentence. Second one.

BEAT host Host
SCENE host
DO hold
USER Hello there.
REPLY Hi. How can I help?
WITH DO replay 2 1.5
CAMERA device
NARRATOR Look closer.
DO click [data-tab="trace"] Visual Trace
SHOWN Quiet answer.
PAUSE 1
`;

/** Every clip the mini script needs, each one second long. */
function lengthsFor(src: string, sec = 1): ClipLengths {
  const out: ClipLengths = {};
  for (const c of clipRequests(parseScript(src))) out[c.id] = { sec };
  return out;
}

describe('script parser', () => {
  it('parses voices, regions, beats and steps', () => {
    const s = parseScript(MINI);
    expect(s.voices.reply.voice).toBe('bm_george');
    expect(s.maxSeconds).toBe(60);
    expect(s.regions['device']).toEqual({ x: 150, y: 112, w: 1140, h: 641 });
    expect(s.beats.map((b) => b.id)).toEqual(['open', 'host']);
    expect(s.beats[0]?.scene).toEqual({ kind: 'card', card: 'open' });
    const kinds = s.beats[1]?.steps.map((x) => x.kind);
    expect(kinds).toEqual(['do', 'speech', 'speech', 'do', 'camera', 'speech', 'do', 'speech', 'pause']);
  });

  it('splits on sentence ends but not inside "3 a.m." style text, and keeps spoken overrides', () => {
    expect(splitSentences('Power came back at 3:12. Fourteen devices restarted.')).toEqual(['Power came back at 3:12.', 'Fourteen devices restarted.']);
    expect(splitSentences('Why at 3 a.m.? It was quiet.')).toEqual(['Why at 3 a.m.?', 'It was quiet.']);
    const s = parseScript(MINI.replace('USER Hello there.', 'USER At 3 a.m. || At three A M.'));
    const user = s.beats[1]?.steps[1];
    expect(user?.kind === 'speech' && user.line.text).toBe('At 3 a.m.');
    expect(user?.kind === 'speech' && user.line.sentences).toEqual(['At three A M.']);
  });

  it('SHOWN replies are not voiced', () => {
    const ids = clipRequests(parseScript(MINI)).map((c) => c.text);
    expect(ids).not.toContain('Quiet answer.');
    expect(ids).toContain('Hi.');
  });

  it('rejects mistakes with the line number', () => {
    expect(() => parseScript(MINI.replace('PAUSE 1', 'PAUSE forever'))).toThrow(/line \d+: PAUSE/);
    expect(() => parseScript(MINI.replace('SCENE host', 'SCENE card nope'))).toThrow(/SCENE/);
    expect(() => parseScript(MINI.replace('DO click', 'DO tap'))).toThrow(/unknown DO verb/);
    expect(() => parseScript(MINI.replace('CAMERA device', 'CAMERA nowhere'))).toThrow(/camera region/);
    expect(() => parseScript(MINI.replace('CAMERA device', 'CAMERA device slowly'))).toThrow(/CAMERA move/);
    expect(() => parseScript(MINI.replace('VOICE reply bm_george 1\n', ''))).toThrow(/VOICE reply/);
    expect(() => parseScript(MINI.replace('DO replay 2 1.5', 'DO replay two'))).toThrow(/DO replay needs/);
    expect(() => parseScript(MINI.replace('SCENE card open', 'SCENE card quotes'))).toThrow(/SCENE/);
  });

  it('clip ids are stable and depend on voice and text', () => {
    const v = { voice: 'af_heart', speed: 1 };
    expect(clipId('narrator', v, 'Hi.')).toBe(clipId('narrator', v, 'Hi.'));
    expect(clipId('narrator', v, 'Hi.')).not.toBe(clipId('narrator', { ...v, voice: 'af_bella' }, 'Hi.'));
  });

  it('the real script parses, voices every USER and REPLY line, and never imitates Alexa (no af_ voice for replies)', () => {
    const s = parseScript(readFileSync(SCRIPT_FILE, 'utf8'));
    expect(s.voices.narrator.voice).toBe('af_heart');
    expect(s.voices.user.voice).toBe('am_michael');
    expect(s.voices.reply.voice.startsWith('af_')).toBe(false);
    expect(s.beats.length).toBeGreaterThanOrEqual(10);
    const host = s.beats.filter((b) => b.scene.kind === 'host').map((b) => b.id);
    expect(host).toContain('trace');
  });

  it('the real script names no third party brand in anything it shows or says', () => {
    const s = parseScript(readFileSync(SCRIPT_FILE, 'utf8'));
    const texts: string[] = [];
    for (const b of s.beats) {
      for (const st of b.steps) {
        if (st.kind === 'speech') texts.push(st.line.text, st.line.spoken);
        if (st.kind === 'label' && st.text) texts.push(st.text);
        if (st.kind === 'item' && 'text' in st.item) texts.push(st.item.text);
        if (st.kind === 'item' && 'cells' in st.item) texts.push(...st.item.cells);
        if (st.kind === 'item' && st.item.kind === 'item') texts.push(st.item.group);
      }
    }
    expect(findMarks(texts.join('\n'))).toEqual([]);
    expect(texts.join(' ')).not.toMatch(/[\u2013\u2014]| - /);
  });
});

describe('timeline', () => {
  const tl = buildTimeline(parseScript(MINI), lengthsFor(MINI));

  it('lays steps end to end from measured lengths', () => {
    // open: quote at 0, PAUSE read for 3 words, narrator 2 sentences of 1 s with a sentence gap.
    const open = tl.beats[0];
    const narr = tl.audio.filter((a) => a.beat === 'open');
    expect(narr[0]?.start).toBeCloseTo(readSeconds('One. Two.'), 3);
    expect(narr[1]?.start).toBeCloseTo(readSeconds('One. Two.') + 1 + GAPS.sentence, 3);
    expect(open?.end).toBeCloseTo(readSeconds('One. Two.') + 2 + GAPS.sentence + GAPS.step + GAPS.beatTail, 3);
    expect(tl.cuts).toEqual([open?.end]);
  });

  it('types the user line while it plays, sends it, then plays the reply', () => {
    const say = tl.actions.find((a) => a.kind === 'say');
    const typing = tl.typing[0];
    expect(typing?.text).toBe('Hello there.');
    expect(say?.kind === 'say' && say.expect).toBe('Hi. How can I help?');
    expect(say?.at).toBeCloseTo((typing?.end ?? 0) + GAPS.userToSend, 3);
    const reply = tl.audio.find((a) => a.role === 'reply');
    expect(reply?.start).toBeCloseTo((say?.at ?? 0) + GAPS.sendToReply, 3);
  });

  it('a camera move can take its own time, and a click waits for it', () => {
    const slow = buildTimeline(parseScript(MINI.replace('CAMERA device', 'CAMERA device 3')), lengthsFor(MINI));
    const cam = slow.cameras[0];
    const click = slow.actions.find((a) => a.kind === 'click');
    expect(cam?.move).toBe(3);
    expect(click?.at).toBeGreaterThanOrEqual((cam?.at ?? 0) + 3 - 1e-6);
  });

  it('a click waits for the camera move to finish', () => {
    const cam = tl.cameras[0];
    const click = tl.actions.find((a) => a.kind === 'click');
    expect(click?.at).toBeGreaterThanOrEqual((cam?.at ?? 0) + GAPS.cameraMove - 1e-6);
  });

  it('holds the house plan moment from before the send, and replays it from the second reply sentence', () => {
    const hold = tl.actions.find((a) => a.kind === 'hold');
    const say = tl.actions.find((a) => a.kind === 'say');
    const replay = tl.actions.find((a) => a.kind === 'replay');
    const second = tl.audio.filter((a) => a.role === 'reply')[1];
    expect(hold?.at).toBeLessThan(say?.at ?? 0);
    expect(replay?.at).toBeCloseTo(second?.start ?? -1, 3);
    expect(replay?.kind === 'replay' && replay.until).toBeCloseTo((second?.start ?? 0) + 1.5, 3);
  });

  it('captions only the narrator, one caption per sentence', () => {
    expect(tl.captions.map((c) => c.text)).toEqual(['First sentence.', 'Second one.', 'Look closer.']);
  });

  it('scales with clip length (no fixed offsets)', () => {
    const longer = buildTimeline(parseScript(MINI), lengthsFor(MINI, 2));
    expect(longer.duration).toBeGreaterThan(tl.duration + 5);
  });

  it('fails loudly when a clip was never measured', () => {
    expect(() => buildTimeline(parseScript(MINI), {})).toThrow(/no measured clip/);
  });

  it('camera eases between regions and settles', () => {
    const cams = [{ at: 1, move: 1, region: { x: 100, y: 100, w: 960, h: 540 }, name: 'z' }];
    expect(cameraAt(cams, 0)).toEqual(FULL);
    const mid = cameraAt(cams, 1.5);
    expect(mid.w).toBeCloseTo((1920 + 960) / 2, 0);
    expect(cameraAt(cams, 3)).toEqual(cams[0]?.region);
    expect(sceneAt(tl, 0).beat).toBe('open');
    expect(sceneAt(tl, tl.duration + 10).beat).toBe('host');
  });

  it('benchmark placeholders show "benchmark running" until a measured value exists', () => {
    const seen = new Map<string, string | null>();
    expect(resolvePlaceholders('{{HOMETRUTH:heldout.fixwright.top1}} top1', {}, seen)).toBe('benchmark running top1');
    expect(seen.get('heldout.fixwright.top1')).toBeNull();
    expect(resolvePlaceholders('{{HOMETRUTH:a.b}}', { 'a.b': '71%' }, seen)).toBe('71%');
  });
});

describe('ASS overlay', () => {
  it('formats colours and times the libass way', () => {
    expect(assColor('#6fd6a8')).toBe('&H00A8D66F');
    expect(assColor('#000000', 0x30)).toBe('&H30000000');
    expect(assTime(61.234)).toBe('0:01:01.23');
  });

  it('wraps and escapes text', () => {
    expect(wrap('one two three four', 9)).toBe('one two\\Nthree\\Nfour');
    expect(wrap('a {b} c', 40)).toBe('a (b) c');
  });

  it('balances two line captions instead of leaving an orphan word', () => {
    const two = wrap('Fixwright finds out why, proves it, and fixes it.', 40).split('\\N');
    expect(two).toHaveLength(2);
    expect(Math.abs((two[0] as string).length - (two[1] as string).length)).toBeLessThan(12);
  });

  it('draws tap rings only where the camera can see them', () => {
    const tl = buildTimeline(parseScript(MINI), lengthsFor(MINI));
    expect(buildAss(tl, [{ at: 0.5, x: 100, y: 100 }])).toContain(',Tap,');
    expect(buildAss(tl, [{ at: 0.5, x: 2400, y: 100 }])).not.toContain(',Tap,');
  });

  it('has captions, the host honesty tag, tap rings and dips', () => {
    const tl = buildTimeline(parseScript(MINI), lengthsFor(MINI));
    const ass = buildAss(tl, [{ at: 5, x: 100, y: 100 }]);
    expect(ass).toContain('Look closer.');
    expect(ass).toContain('Alexa+ host simulated');
    expect(ass).toContain('not Alexa');
    expect(findMarks(ass)).toEqual([]);
    expect(ass).toContain(',Tap,');
    expect(ass).toContain(',Dip,');
    expect(ass).toMatch(/PlayResX: 1920/);
  });
});

describe('audio', () => {
  const sine = (sec: number, amp: number, rate = 24000): Float32Array => Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / rate));

  it('round trips float WAV and trims silence with a margin', () => {
    const rate = 24000;
    const s = new Float32Array(rate);
    s.set(sine(0.5, 0.5), rate / 4);
    const back = decodeWav(encodeWav({ sampleRate: rate, samples: s }));
    expect(back.samples.length).toBe(rate);
    const t = trimSilence(back);
    expect(t.samples.length / rate).toBeGreaterThan(0.5);
    expect(t.samples.length / rate).toBeLessThan(0.6);
  });

  it('levels to a target without clipping, and mixes at offsets', () => {
    const quiet = sine(1, 0.01);
    const g = levelGain(quiet, -20);
    expect(rmsDb(quiet.map((x) => x * g))).toBeCloseTo(-20, 0);
    const m = mix([{ start: 0.5, pcm: { sampleRate: 24000, samples: sine(0.25, 0.5) }, gain: 1 }], 1, 24000);
    expect(rmsDb(m.samples, 0, 12000)).toBe(-200);
    expect(rmsDb(m.samples, 12000, 18000)).toBeGreaterThan(-10);
  });
});

describe('plain MCP client and probe parsing', () => {
  it('reads JSON-RPC from JSON or SSE bodies', () => {
    expect(parseRpcBody('application/json', '{"jsonrpc":"2.0","id":0,"result":{"a":1}}')?.result).toEqual({ a: 1 });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    expect(parseRpcBody('text/event-stream', sse)?.result).toEqual({ tools: [] });
  });

  it('cuts long JSON with a byte count and masks tokens', () => {
    expect(cut('abcdef', 3)).toBe('abc… (6 bytes)');
    expect(maskToken('hh_0123456789abcdef')).toBe('hh_0123…cdef');
  });

  it('parses ffmpeg stream headers', () => {
    const p = parseProbe(`  Duration: 00:02:54.62, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 497 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 138 kb/s (default)`);
    expect(p.duration).toBeCloseTo(174.62, 2);
    expect(p.video).toEqual({ codec: 'h264', profile: 'High', pixFmt: 'yuv420p', width: 1920, height: 1080, fps: 30 });
    expect(p.audio).toEqual({ codec: 'aac', rate: 48000, channels: 'stereo' });
  });
});

describe('benchmark card numbers and third party names', () => {
  it('reads right, cannot tell, wrong and right when answering from a HomeTruth result', () => {
    const metrics = (right: number, cant: number, answered: number) => ({
      all: { n: 100, answered, top1: { k: right, n: 100, value: right / 100 }, top1_answered: { k: right, n: answered, value: right / answered }, abstention: { k: cant, n: 100, value: cant / 100 } },
    });
    const r = { format: 'hometruth.results/1', config: { set: 'heldout', n: 100, seed: 1 }, metrics: { fixwright: metrics(78, 19, 81), b1: metrics(71, 4, 96), b2: metrics(83, 3, 97) } } as HomeTruthResult;
    const v = cardValues(r);
    expect(v).toMatchObject({ 'heldout.n': '100', 'heldout.b1.right': '71', 'heldout.b1.wrong': '25', 'heldout.b2.right': '83', 'heldout.fixwright.right_when_answered': '96%', 'heldout.fixwright.cant_tell': '19' });
    expect(() => cardValues({ ...r, metrics: { ...r.metrics, b1: metrics(71, 30, 96) } })).toThrow(/add up/);
  });

  it.runIf(existsSync(HOMETRUTH_FILE))('the narration quotes only numbers that are on the card', () => {
    const v = cardValues(JSON.parse(readFileSync(HOMETRUTH_FILE, 'utf8')) as HomeTruthResult);
    const values = new Set(Object.values(v).map((x) => x.replace('%', '')));
    const bench = parseScript(readFileSync(SCRIPT_FILE, 'utf8')).beats.find((b) => b.id === 'bench');
    const said = (bench?.steps ?? []).flatMap((st) => (st.kind === 'speech' ? [st.line.text] : [])).join(' ');
    const numbers = said.match(/\d+/g) ?? [];
    expect(numbers.length).toBeGreaterThan(2);
    for (const n of numbers) expect(values.has(n), n).toBe(true);
  });

  it('finds brand names but lets the sponsor and open standards through', () => {
    expect(findMarks('the Hue cloud and Home Assistant')).toEqual(['Hue', 'Home Assistant']);
    expect(findMarks("Alexa+ host simulated, the light maker's cloud, Visual Trace")).toEqual([]);
    expect(findStandards('a Zigbee light dropped off Wi-Fi')).toEqual(['Zigbee', 'Wi-Fi']);
    expect(findNonEnglish('Yes, it blinked | haan, jal raha hai')).toEqual(['haan', 'jal raha']);
    expect(findNonEnglish("No, it didn't. The lamp works.")).toEqual([]);
  });
});
