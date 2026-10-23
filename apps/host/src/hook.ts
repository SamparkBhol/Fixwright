// window.__fixwright: the test hook Playwright and the video pipeline drive the demo with, so no script
// has to guess at timing.

import type { ConversationState } from '@fixwright/router';
import type { HostApp } from './app.ts';
import { HOUSE_TIME_ZONE, type DeviceClass, type Theme } from './devices.ts';
import { wallAt, type DotState, type Moment, type Wall } from './house.ts';
import type { Approval, Connection, PushNote, TabId } from './state.ts';

export interface HookSnapshot {
  device: DeviceClass;
  theme: Theme;
  connection: Connection;
  transcript: Array<{ role: 'user' | 'assistant'; text: string; via?: string; tool?: string; status?: string; intent?: string }>;
  spoken: string[];
  speaking: string | null;
  busy: string | null;
  viewTool: string | null;
  viewUri: string | null;
  approval: Approval | null;
  conversation: ConversationState;
  pushes: PushNote[];
  /** The push notification on the device right now, if any. */
  toast: PushNote | null;
  traceCount: number;
  clockMs: number;
  /** The house plan as last read, the wall for the current house time, and the newest moment. */
  house: {
    /** The wall house time asks for, and the wall on screen (a moment can hold another one). */
    wall: Wall;
    shown: Wall | null;
    morning: boolean;
    rooms: Array<{ id: string; dots: Array<{ entityId: string; state: DotState }> }> | null;
    moment: Pick<Moment, 'id' | 'kind' | 'line' | 'devices' | 'spanMs'> & { frames: number } | null;
  };
}

export interface FixwrightHook {
  readonly version: 1;
  ready(): Promise<void>;
  /**
   * Say something (as if typed) and resolve once its tool call and view render are done. idle() also
   * waits for calls a view starts, and resolves early when an approval is waiting for an answer.
   */
  say(text: string): Promise<HookSnapshot>;
  setDevice(device: DeviceClass): Promise<HookSnapshot>;
  setTheme(theme: Theme): void;
  setTab(tab: TabId): void;
  /** Pin the host clock (ISO or ms) for the page and the views; null follows real time again. */
  setClock(time: string | number | null): void;
  /** Answer the open approval prompt, then resolve once the approved call (or the decline) is done. */
  approve(allow: boolean): Promise<HookSnapshot>;
  idle(): Promise<HookSnapshot>;
  snapshot(): HookSnapshot;
  /** The Visual Trace as plain data (JSON-RPC on the mcp and bridge lanes); `t` is performance.now() in the page. */
  trace(): Array<{ lane: string; dir: string; kind: string; method: string; tool: string | null; id: string | number | null; msg: unknown; t: number; session: number }>;
  /** Host-side events: approvals, refused view calls, transport errors. */
  events(): Array<{ type: string; detail?: unknown }>;
  /** Show the newest plan moment frozen `ms` after its start, for screenshots and the video; null plays live again. */
  holdMoment(ms: number | null): HookSnapshot;
}

export function createHook(app: HostApp): FixwrightHook {
  const snapshot = (): HookSnapshot => {
    const s = app.store.get();
    return {
      device: s.device,
      theme: s.theme,
      connection: s.connection,
      transcript: s.transcript.map((e) => ({
        role: e.role,
        text: e.text,
        ...(e.via ? { via: e.via } : {}),
        ...(e.tool ? { tool: e.tool.name, status: e.tool.status } : {}),
        ...(e.intent ? { intent: e.intent } : {}),
      })),
      spoken: [...app.spoken],
      speaking: s.speaking,
      busy: s.busy,
      viewTool: s.viewTool,
      viewUri: app.views.current?.uri ?? null,
      approval: s.approval,
      conversation: s.conversation,
      pushes: s.pushes,
      toast: s.toast,
      traceCount: app.trace.entries.length,
      clockMs: app.clock.nowMs(),
      house: {
        wall: wallAt(app.clock.nowMs(), s.house?.clock?.tz ?? HOUSE_TIME_ZONE),
        shown: (document.getElementById('stage')?.dataset['wall'] as Wall | undefined) ?? null,
        morning: document.getElementById('stage')?.dataset['morning'] === 'true',
        rooms: s.house ? s.house.rooms.map((r) => ({ id: r.id, dots: r.dots.map((d) => ({ entityId: d.entityId, state: d.state })) })) : null,
        moment: s.moment ? { id: s.moment.id, kind: s.moment.kind, line: s.moment.line, devices: s.moment.devices, spanMs: s.moment.spanMs, frames: s.moment.frames.length } : null,
      },
    };
  };
  return {
    version: 1,
    ready: () => app.ready(),
    async say(text) {
      await app.say(text, 'hook');
      await app.idle();
      return snapshot();
    },
    async setDevice(device) {
      await app.setDevice(device);
      await app.idle();
      return snapshot();
    },
    setTheme: (t) => app.setTheme(t),
    setTab: (t) => app.setTab(t),
    setClock: (time) => app.setClock(time),
    async approve(allow) {
      app.answerApproval(allow);
      await app.idle();
      return snapshot();
    },
    async idle() {
      await app.idle();
      return snapshot();
    },
    snapshot,
    trace: () => app.trace.entries.map((e) => ({ lane: e.lane, dir: e.dir, kind: e.kind, method: e.method, tool: e.tool, id: e.id, msg: e.msg, t: e.t, session: e.session })),
    events: () => app.events.map((e) => ({ type: e.type, ...(e.detail === undefined ? {} : { detail: e.detail }) })),
    holdMoment(ms) {
      app.store.set({ momentAt: ms === null || !Number.isFinite(ms) ? null : Math.max(0, ms) });
      return snapshot();
    },
  };
}
