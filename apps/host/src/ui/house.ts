// The house plan under the device and the wall behind it. Both follow /demo/state and the moments app.ts
// builds from logged switches; the only timers here play a moment back.

import type { HostApp } from '../app.ts';
import { HOUSE_TIME_ZONE } from '../devices.ts';
import { statesAt, wallAt, wallCueAt, type DotState, type HouseRoom, type Moment, type WallCue } from '../house.ts';
import type { AppState } from '../state.ts';
import { h } from './dom.ts';

const STATE_WORDS: Record<DotState, string> = { on: 'on', off: 'off', unavailable: 'offline' };

export interface HouseHooks {
  /** The house time a playing replay shows (null when the plan is live again), for the stage label. */
  onReplayClock(ms: number | null): void;
}

export function mountHouse(root: HTMLElement, stage: HTMLElement, app: HostApp, hooks: HouseHooks): void {
  const { store } = app;
  const plan = h('div', { class: 'plan', role: 'group', 'aria-label': 'House plan' });
  const line = h('p', { class: 'house-line', 'aria-live': 'polite' });
  const key = (name: string, dot: Record<string, string>, text: string): HTMLElement =>
    h('span', { class: 'legend-item', 'data-key': name, hidden: true }, h('i', { class: 'dot', ...dot }), h('span', { text }));
  const answeredKey = key('answered', { 'data-state': 'off', 'data-answered': 'true' }, 'Answered');
  const changedKey = key('changed', { 'data-state': 'off', 'data-changed': 'true' }, 'Just changed');
  const legend = h(
    'p',
    { class: 'legend', 'aria-hidden': 'true' },
    ...(['on', 'off', 'unavailable'] as const).map((st) => h('span', { class: 'legend-item' }, h('i', { class: 'dot', 'data-state': st }), h('span', { text: st === 'unavailable' ? 'Offline' : st === 'on' ? 'On' : 'Off' }))),
    answeredKey,
    changedKey,
  );
  root.append(plan, h('div', { class: 'house-foot' }, line, legend));

  const reduced = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const still = (): boolean => app.config.testMode || reduced?.matches === true;

  let dots = new Map<string, { el: HTMLElement; room: HTMLElement; live: DotState; name: string }>();
  let overrides = new Map<string, DotState>();
  let answered = new Set<string>();
  let changed = new Set<string>();
  let focus = new Set<string>();
  let cue: WallCue | null = null;
  let timers: number[] = [];
  let shown: Moment | null = null;
  let moving = false;
  // The line says what the newest moment showed; once the person says something new it is old news.
  let momentTurn = 0;

  const zone = (): string => store.get().house?.clock?.tz ?? HOUSE_TIME_ZONE;

  // Until the house clock is read the wall keeps its day default, and it only fades once it has been
  // painted from house time, so a page opened at night in the browser's zone never flashes.
  let wallReady = false;
  function paintWall(): void {
    if (!store.get().clockKnown && cue === null) return;
    stage.dataset['wall'] = cue === null ? wallAt(app.clock.nowMs(), zone()) : cue === 'morning' ? 'day' : cue;
    stage.dataset['morning'] = String(cue === 'morning');
    if (!wallReady) {
      wallReady = true;
      requestAnimationFrame(() => requestAnimationFrame(() => (stage.dataset['wallReady'] = 'true')));
    }
  }

  function paintLine(): void {
    if (!shown) return;
    line.textContent = moving && shown.played ? `${shown.line} ${shown.played}` : shown.line;
  }

  function paintDots(): void {
    const rooms = new Set<HTMLElement>();
    for (const [id, d] of dots) {
      const state = overrides.get(id) ?? d.live;
      const words = `${d.name}, ${STATE_WORDS[state]}${answered.has(id) ? ', answered the flash test' : ''}${changed.has(id) ? ', just changed' : ''}`;
      d.el.dataset['state'] = state;
      d.el.dataset['replay'] = String(overrides.has(id));
      d.el.dataset['answered'] = String(answered.has(id));
      d.el.dataset['changed'] = String(changed.has(id) && !answered.has(id));
      d.el.dataset['focus'] = String(focus.has(id));
      d.el.setAttribute('aria-label', words);
      d.el.title = words;
      if (focus.has(id)) rooms.add(d.room);
    }
    for (const r of plan.children) (r as HTMLElement).dataset['focus'] = String(rooms.has(r as HTMLElement));
    answeredKey.hidden = answered.size === 0;
    changedKey.hidden = [...changed].every((id) => answered.has(id) || !dots.has(id));
  }

  // A tap on the plan says what a person would say, so it runs through the same router and tools as typing.
  function tapTarget(el: HTMLElement, utterance: () => string): void {
    const go = (): void => {
      if (app.store.get().busy) return;
      void app.say(utterance(), 'tap');
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        go();
      }
    });
  }

  // Room widths follow the most dots a room has held, so retiring a device never moves the walls.
  const most = new Map<string, number>();
  function build(rooms: readonly HouseRoom[]): void {
    dots = new Map();
    plan.replaceChildren(
      ...rooms.map((r) => {
        most.set(r.id, Math.max(most.get(r.id) ?? 0, r.dots.length));
        const label = h('span', { class: 'room-name', role: 'button', tabindex: '0', title: `Check up on the ${r.name.toLowerCase()}`, text: r.name });
        tapTarget(label, () => `Run a checkup on the ${r.name.toLowerCase()}`);
        const room = h('div', { class: 'room', 'data-room': r.id, style: `--weight:${(most.get(r.id) ?? 0) + 3}` }, label);
        room.append(
          h(
            'span',
            { class: 'room-dots' },
            ...r.dots.map((d) => {
              const el = h('i', { class: 'dot', role: 'button', tabindex: '0', 'data-entity': d.entityId });
              tapTarget(el, () => {
                const state = overrides.get(d.entityId) ?? dots.get(d.entityId)?.live ?? d.state;
                const name = d.name.toLowerCase();
                if (state === 'unavailable') return `Why is the ${name} not responding?`;
                return state === 'on' ? `Turn off the ${name}` : `Turn on the ${name}`;
              });
              dots.set(d.entityId, { el, room, live: d.state, name: d.name });
              return el;
            }),
          ),
        );
        return room;
      }),
    );
    paintDots();
  }

  function stop(): void {
    for (const t of timers) clearTimeout(t);
    timers = [];
    overrides = new Map();
    cue = null;
    moving = false;
    hooks.onReplayClock(null);
  }

  function paint(): void {
    paintDots();
    paintWall();
    paintLine();
  }

  function frameAt(m: Moment, t: number): void {
    overrides = statesAt(m, t);
    cue = wallCueAt(m, t);
    hooks.onReplayClock(m.clockMs !== null && cue === 'night' ? m.clockMs : null);
    paint();
  }

  function begin(m: Moment): void {
    shown = m;
    answered = new Set(m.kind === 'flash' ? m.devices : []);
    focus = new Set(m.kind === 'flash' ? m.devices : []);
  }

  function play(m: Moment): void {
    stop();
    begin(m);
    if (still() || m.duration === 0) {
      paint();
      return;
    }
    moving = true;
    const times = [...new Set([0, ...m.frames.map((f) => f.at), ...m.wall.map((w) => w.at)])].sort((a, b) => a - b);
    for (const t of times) timers.push(window.setTimeout(() => frameAt(m, t), t));
    timers.push(
      window.setTimeout(() => {
        stop();
        paint();
      }, m.duration),
    );
    paint();
  }

  function render(s: AppState, prev: AppState | null): void {
    if (s.moment !== prev?.moment) momentTurn = s.transcript.at(-1)?.id ?? 0;
    const said = s.transcript.at(-1);
    if (prev && s.transcript !== prev.transcript && said?.role === 'user' && said.id > momentTurn) {
      shown = null;
      line.textContent = '';
      if (focus.size > 0) {
        focus = new Set();
        paintDots();
      }
    }
    if (!prev || s.house !== prev.house) {
      root.hidden = !s.house;
      build(s.house?.rooms ?? []);
    }
    if (!prev || s.changed !== prev.changed) {
      changed = new Set(s.changed);
      paintDots();
    }
    const held = s.moment !== null && s.momentAt !== null;
    if (held && (s.moment !== prev?.moment || s.momentAt !== prev?.momentAt)) {
      stop();
      if (s.moment) {
        begin(s.moment);
        // Held frames are the replay itself (the video's and the screenshots'), so the line says so.
        moving = true;
        frameAt(s.moment, s.momentAt ?? 0);
      }
    } else if (!held && s.moment && (s.moment !== prev?.moment || prev?.momentAt !== null)) {
      if (s.moment !== prev?.moment) play(s.moment);
      else {
        stop();
        paint();
      }
    }
    if (!s.moment && prev?.moment) {
      stop();
      shown = null;
      answered = new Set();
      focus = new Set();
      line.textContent = '';
      paintDots();
    }
    if (!prev || s.tick !== prev.tick || s.house !== prev.house || s.clockKnown !== prev.clockKnown) {
      if (!held) paintWall();
    }
  }

  render(store.get(), null);
  store.subscribe((s, prev) => render(s, prev));
}
