// App state: one plain object, replaced on every change, with subscribers. Every visual is a function of
// this state plus the injectable clock.

import type { ConversationState } from '@fixwright/router';
import type { DeviceClass, Theme } from './devices.ts';
import type { Household } from './demo-api.ts';
import type { HouseClock, HouseRoom, Moment } from './house.ts';

export type TabId = 'conversation' | 'trace' | 'latency' | 'house' | 'about';
/**
 * The console's tab row. `short` is what a phone width page shows, so the row fits at 390 px. About is not in
 * the row: the top bar opens it.
 */
export const TABS: ReadonlyArray<{ id: Exclude<TabId, 'about'>; label: string; short: string }> = [
  { id: 'conversation', label: 'Conversation', short: 'Chat' },
  { id: 'trace', label: 'Visual Trace', short: 'Trace' },
  { id: 'latency', label: 'Latency', short: 'Latency' },
  { id: 'house', label: 'Break my house', short: 'Break it' },
];

export interface ToolChip {
  name: string;
  title: string;
  status: string;
  ms: number;
  isError: boolean;
  origin: 'assistant' | 'view';
}

export interface TranscriptEntry {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  /**
   * How the words arrived. 'view': a view's ui/message; 'tap': the person tapped a button in a view;
   * 'approval': the person's tap on the approval sheet.
   */
  via?: 'typed' | 'voice' | 'view' | 'suggestion' | 'hook' | 'approval' | 'tap';
  intent?: string;
  tool?: ToolChip;
}

export interface Connection {
  status: 'connecting' | 'ready' | 'error';
  protocolVersion?: string;
  era?: string;
  server?: { name: string; version: string };
  tools: number;
  error?: string;
}

export interface Approval {
  tool: string;
  title: string;
  lines: string[];
  /** Label of the yes button, e.g. "Yes, apply it". */
  confirm: string;
  /** The small print under the lines, e.g. "Nothing changes until you say yes." */
  footer: string;
  /** Set when a view's message asked for this: what it sent on the person's behalf. */
  note: string | null;
}

export interface HouseLogEntry {
  id: number;
  action: string;
  ok: boolean;
  status: number;
  ms: number;
  summary: string;
}

export interface PushNote {
  title: string;
  message: string;
  at: string;
}

export interface HouseState {
  rooms: HouseRoom[];
  clock: HouseClock | null;
}

/**
 * What a display shows for a turn whose tool has no view (switch_device, protect_device): the reply as
 * text, the way an Echo Show answers in words, so an older card never stands in for the newest answer.
 */
export interface ReplyCard {
  tool: string;
  status: string;
  text: string;
  /** The device the turn switched, as the result names it. */
  switched: { name: string; state: string } | null;
}

export interface AppState {
  device: DeviceClass;
  theme: Theme;
  tab: TabId;
  connection: Connection;
  transcript: TranscriptEntry[];
  /** What the host is doing while a tool call runs, e.g. "Checking with Fixwright". */
  busy: string | null;
  speaking: string | null;
  listening: boolean;
  interim: string;
  /** Tool name of the view on screen. */
  viewTool: string | null;
  replyCard: ReplyCard | null;
  approval: Approval | null;
  household: Household | null;
  houseLog: HouseLogEntry[];
  pushes: PushNote[];
  /** The newest push, shown as a notification on the device until the person's next turn. */
  toast: PushNote | null;
  /** The transcript entry id the push landed after: while nothing newer is said, the captions show it. */
  toastAfter: number;
  /** Faults active in the simulated house, as the server last reported them (null: not known). */
  activeFaults: string[] | null;
  conversation: ConversationState;
  /** The house plan as /demo/state last showed it (null until the first read). */
  house: HouseState | null;
  /** The newest moment the plan replays: a flash, the 3 a.m. restore or the morning. */
  moment: Moment | null;
  /** Set by the test hook: the moment is shown frozen this many ms after its start instead of playing. */
  momentAt: number | null;
  /** Plan dots whose state the newest tool call changed, marked until the next request. */
  changed: string[];
  /** The house clock has been read (or pinned), so the wall and the clocks can show house time. */
  clockKnown: boolean;
  /** Bumped by the clock ticker so the idle screen renders again. */
  tick: number;
  micSupported: boolean;
}

export interface Store<S> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: (s: S, prev: S) => void): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const subs = new Set<(s: S, prev: S) => void>();
  return {
    get: () => state,
    set(patch) {
      const prev = state;
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      for (const fn of subs) fn(state, prev);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
