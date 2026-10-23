// Guide, List pattern ("a See More button opens the full list") and CX testing (no cut off content without
// an affordance). Steps that failed or were put back never fold.
import type { RepairStepStatus } from '@fixwright/protocol';
import { fitsCanvas, type Surface } from './context.ts';
import { plural } from './format.ts';

/** Shorter lists never fold: a "1 more step" row would take the room of the step it hides. */
export const FOLD_MIN = 5;
export const FOLD_KEEP = 3;

export interface FoldStep {
  status: RepairStepStatus;
  readBack: boolean;
}

/** 'fit': fold only as far as the column needs; 'keep': keep FOLD_KEEP steps; 'none': list every step. */
export type FoldMode = 'fit' | 'keep' | 'none';

export function foldMode(s: Pick<Surface, 'displayMode' | 'orientation' | 'height'>): FoldMode {
  if (s.displayMode === 'fullscreen') return 'none';
  return fitsCanvas(s) ? 'fit' : 'keep';
}

const isProblem = (s: RepairStepStatus) => s === 'failed' || s === 'rolled_back';

export function hiddenSteps(steps: readonly FoldStep[], keep: number): number[] {
  if (steps.length < FOLD_MIN) return [];
  const problems = steps.filter((s) => isProblem(s.status)).length;
  let room = Math.max(1, keep) - problems;
  const hidden: number[] = [];
  steps.forEach((s, i) => {
    if (isProblem(s.status)) return;
    if (room > 0) room--;
    else hidden.push(i);
  });
  // Folding a single step saves nothing.
  return hidden.length >= 2 ? hidden : [];
}

const STATUS_WORD: Record<RepairStepStatus, string> = { done: 'done', pending: 'to do', skipped: 'skipped', rolled_back: 'put back', failed: 'failed' };
const STATUS_ORDER: RepairStepStatus[] = ['done', 'failed', 'rolled_back', 'skipped', 'pending'];

export function foldLabel(hidden: readonly FoldStep[]): string {
  const n = hidden.length;
  const head = `${n} more ${plural(n, 'step', 'steps')}`;
  const kinds = STATUS_ORDER.filter((k) => hidden.some((s) => s.status === k));
  if (kinds.length === 1) {
    const only = kinds[0] as RepairStepStatus;
    if (only === 'pending') return head;
    if (only === 'done' && hidden.every((s) => s.readBack)) return `${head}, all read back`;
    return `${head}, all ${STATUS_WORD[only]}`;
  }
  return `${head}: ${kinds.map((k) => `${hidden.filter((s) => s.status === k).length} ${STATUS_WORD[k]}`).join(', ')}`;
}

export const SHOW_FEWER = 'Show fewer steps';

export interface FoldResult {
  shown: number;
  hidden: number;
}

export interface FoldOptions {
  mode: FoldMode;
  expanded: boolean;
  onToggle(): void;
}

function overflows(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 1;
}

// Runs before focus is restored, so a focused fold row keeps its focus across renders.
export function applyStepFold(root: ParentNode, o: FoldOptions): FoldResult {
  let result: FoldResult = { shown: 0, hidden: 0 };
  for (const block of Array.from(root.querySelectorAll<HTMLElement>('.block-steps'))) {
    const items = Array.from(block.querySelectorAll<HTMLLIElement>('.steps > .step'));
    const toggle = block.querySelector<HTMLButtonElement>('.steps-more');
    const col = block.closest<HTMLElement>('.main-col');
    const steps: FoldStep[] = items.map((li) => ({ status: (li.dataset.status ?? 'pending') as RepairStepStatus, readBack: Boolean(li.querySelector('.step-rb')) }));
    const show = (hide: number[]) => {
      items.forEach((li, i) => li.classList.toggle('is-folded', hide.includes(i)));
      result = { shown: items.length - hide.length, hidden: hide.length };
      if (!toggle) return;
      toggle.hidden = hide.length === 0;
      setToggle(toggle, false, foldLabel(hide.map((i) => steps[i] as FoldStep)));
    };
    col?.classList.remove('is-scrolling');
    show([]);
    if (!toggle) continue;
    toggle.onclick = () => o.onToggle();
    if (o.mode === 'none' || items.length < FOLD_MIN) continue;

    if (o.expanded) {
      toggle.hidden = false;
      setToggle(toggle, true, SHOW_FEWER);
      // A fixed height screen scrolls the evidence column only: the header and the decision stay put.
      if (o.mode === 'fit') col?.classList.add('is-scrolling');
      continue;
    }
    if (o.mode === 'keep') {
      show(hiddenSteps(steps, FOLD_KEEP));
      continue;
    }
    if (!col || !overflows(col)) continue;
    for (let keep = items.length - 2; keep >= 1; keep--) {
      const hide = hiddenSteps(steps, keep);
      show(hide);
      if (!overflows(col)) break;
    }
  }
  return result;
}

function setToggle(toggle: HTMLButtonElement, open: boolean, label: string): void {
  toggle.setAttribute('aria-expanded', String(open));
  toggle.classList.toggle('is-open', open);
  const l = toggle.querySelector<HTMLElement>('.steps-more-label');
  if (l) l.textContent = label;
}

export function createStepFold(rerender: () => void) {
  let open = false;
  let shownWhenClosed = 0;
  let reveal = false;
  return {
    reset(): void {
      open = false;
    },
    apply(root: HTMLElement, surface: Pick<Surface, 'displayMode' | 'orientation' | 'height'>): FoldResult {
      const r = applyStepFold(root, {
        mode: foldMode(surface),
        expanded: open,
        onToggle: () => {
          open = !open;
          reveal = open;
          rerender();
        },
      });
      if (!open) shownWhenClosed = r.shown;
      return r;
    },
    afterMount(root: HTMLElement): void {
      if (!reveal) return;
      reveal = false;
      root.querySelectorAll<HTMLElement>('.steps > .step')[shownWhenClosed]?.scrollIntoView({ block: 'nearest' });
    },
    isOpen: () => open,
  };
}

export type StepFold = ReturnType<typeof createStepFold>;
