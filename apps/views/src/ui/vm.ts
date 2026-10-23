// Plain data with no DOM, so every label, number and tool call is unit testable.
import type { RepairStepStatus, ToolName } from '@fixwright/protocol';
import type { IconName } from './icons.ts';
import type { PayloadKind } from './payload.ts';

export type Tone = 'pass' | 'fail' | 'warn' | 'info' | 'neutral';

export interface ChipVM {
  label: string;
  tone: Tone;
  icon: IconName;
}

export interface BarVM {
  key: string;
  label: string;
  pct: number;
  lead: boolean;
  tone: Tone;
}

export interface ProbeVM {
  key: string;
  label: string;
  outcome: 'pass' | 'fail' | 'unknown';
  /** Screen reader text after the label: "Hub, passed". */
  outcomeText: string;
  detail: string;
  evidence: number;
  human: boolean;
}

export interface TimelineVM {
  key: string;
  time: string;
  label: string;
  evidence: number;
}

export interface StepVM {
  key: string;
  n: number;
  label: string;
  status: RepairStepStatus;
  statusText: string;
  readBack?: string;
}

export interface CheckVM {
  key: string;
  when: string;
  result: 'pass' | 'fail';
  detail: string;
}

export interface ClaimVM {
  key: string;
  text: string;
  evidence: number;
}

export interface ToolCall {
  name: ToolName;
  arguments: Record<string, unknown>;
}

export interface ActionVM {
  id: string;
  label: string;
  pendingLabel: string;
  style: 'primary' | 'secondary';
  tool?: ToolCall;
  local?: 'cancel' | 'back';
  /** Words for the conversation (ui/message), for a step only the conversation can take. */
  ask?: string;
}

export interface DecisionVM {
  icon: IconName;
  tone: Tone;
  lead?: string;
  text: string;
  note?: string;
  /** 'hero' sets the text one type step larger: a question, or the next check time. */
  emphasis?: 'hero';
  actions: ActionVM[];
}

export type BlockVM =
  | { type: 'bars'; heading: string; items: BarVM[] }
  | { type: 'probes'; heading: string; items: ProbeVM[] }
  | { type: 'timeline'; heading: string; items: TimelineVM[] }
  | { type: 'diff'; heading: string; lines: string[]; conflicts: string[] }
  | { type: 'changes'; heading: string; rows: { key: string; entity: string; field: string; from: string; to: string }[] }
  | { type: 'steps'; heading: string; items: StepVM[] }
  | { type: 'checks'; heading: string; items: CheckVM[] }
  | { type: 'claims'; heading: string; items: ClaimVM[] };

export interface PanelVM {
  screen: PayloadKind;
  eyebrow: string;
  title: string;
  chip: ChipVM;
  simulated: boolean;
  hub?: string;
  strip?: Extract<BlockVM, { type: 'probes' }>;
  main: BlockVM[];
  /** Fullscreen only (guide, Display modes: more room, same experience). */
  details: BlockVM[];
  decision: DecisionVM;
}

export interface FindingVM {
  key: string;
  kind: string;
  icon: IconName;
  severity: 'high' | 'medium' | 'low';
  severityLabel: string;
  tone: Tone;
  title: string;
  detail: string;
  action?: ActionVM;
  fixed: boolean;
  /** Asked the conversation for guidance; the answer comes there. */
  asked: boolean;
}

export interface CarouselVM {
  eyebrow: string;
  title: string;
  chip: ChipVM;
  simulated: boolean;
  hub?: string;
  items: FindingVM[];
}

export interface TimeContext {
  locale: string;
  timeZone: string | undefined;
  nowMs: number;
}
