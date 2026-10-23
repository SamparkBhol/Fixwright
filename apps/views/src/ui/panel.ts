// Fullscreen is the same experience with more room: it adds the detail blocks (guide, Display modes).
import { actionBar, block, decisionCard, header, iconButton, probeStrip, type ActionState } from './components.ts';
import { fitsCanvas, type Surface } from './context.ts';
import { h } from './dom.ts';
import { MAX_INLINE_PROBES } from './screens.ts';
import type { PanelVM } from './vm.ts';

export interface PanelOptions {
  surface: Surface;
  actions: ActionState;
  error: string | null;
  notice?: string | null;
  barsFrom: Record<string, number> | null;
  /** Only when the host offers fullscreen. */
  onToggleMode?: () => void;
}

export function modeToggle(surface: Surface, onToggle: (() => void) | undefined): HTMLButtonElement | null {
  if (!onToggle || !surface.canFullscreen || surface.deviceClass === 'voice') return null;
  const full = surface.displayMode === 'fullscreen';
  return iconButton(full ? 'Show less' : 'Show details', full ? 'collapse' : 'expand', onToggle, 'toggle-mode');
}

export function renderPanel(vm: PanelVM, o: PanelOptions): HTMLElement {
  const full = o.surface.displayMode === 'fullscreen';
  const portrait = o.surface.orientation === 'portrait';
  const pinned = portrait && vm.decision.actions.length > 0;
  // Portrait reads top down, so the decision leads. A plan keeps the dry run first: a commit screen shows
  // what will change before the button that changes it.
  const decisionFirst = portrait && vm.screen !== 'plan';
  const head = header({
    eyebrow: vm.eyebrow,
    title: vm.title,
    chip: vm.chip,
    simulated: vm.simulated,
    hub: vm.hub,
    titleId: 'view-title',
    side: modeToggle(o.surface, o.onToggleMode),
  });
  const strip = vm.strip && !full ? probeStrip(vm.strip, MAX_INLINE_PROBES, 'strip') : null;
  // Fullscreen details close the evidence column, so a pinned decision stays beside them (panel.css).
  const details = full
    ? h(
        'div',
        { class: 'details' },
        ...(vm.strip ? [block(vm.strip, { idBase: 'detail-strip', barsFrom: null })] : []),
        ...vm.details.map((b, i) => block(b, { idBase: `detail-${i}`, barsFrom: null })),
      )
    : null;
  const mainCol = h('div', { class: 'main-col' }, ...vm.main.map((b, i) => block(b, { idBase: `main-${i}`, barsFrom: o.barsFrom })), details);
  const outcome = { error: o.error, notice: o.notice ?? null };
  const decision = decisionCard(vm.decision, o.actions, pinned ? { error: null } : outcome, 'decision', { actions: !pinned });
  const bar = pinned ? actionBar(vm.decision, o.actions, outcome) : null;
  return decisionFirst
    ? h('div', { class: 'panel', data: { screen: vm.screen } }, head, decision, bar, strip, h('div', { class: 'body' }, mainCol))
    : h('div', { class: 'panel', data: { screen: vm.screen } }, head, strip, h('div', { class: 'body' }, mainCol, decision), bar);
}

// Gentlest first, and they add up. Nothing that carries meaning is ever hidden (CX testing: no truncation).
export const DECISION_FIT_STEPS = ['fit-tight', 'fit-wide', 'fit-small', 'fit-wider'] as const;

// scrollHeight misses content that only eats the bottom padding, since a flex container's scroll size does
// not count it. Rendered px on both sides, so the root zoom cancels out.
function spills(d: HTMLElement): boolean {
  const box = d.getBoundingClientRect();
  const scale = d.offsetHeight > 0 ? box.height / d.offsetHeight : 1;
  const cs = getComputedStyle(d);
  const limit = box.bottom - (parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth)) * scale;
  for (const child of Array.from(d.children)) if (child.getBoundingClientRect().bottom > limit + 0.5) return true;
  const body = d.parentElement;
  return Boolean(body) && box.bottom > (body as HTMLElement).getBoundingClientRect().bottom + 0.5;
}

// Runs before the step fold, which measures the evidence column at the width this leaves. On a fixed
// landscape screen a long verdict plus a declined or failed line can push the buttons past the border.
export function fitDecision(root: ParentNode, s: Pick<Surface, 'displayMode' | 'orientation' | 'height'>): number {
  const d = root.querySelector<HTMLElement>('.body > .decision');
  if (!d) return 0;
  d.classList.remove(...DECISION_FIT_STEPS);
  let applied = 0;
  if (fitsCanvas(s)) {
    while (applied < DECISION_FIT_STEPS.length && spills(d)) d.classList.add(DECISION_FIT_STEPS[applied++] as string);
  }
  d.dataset.fit = String(applied);
  return applied;
}

// A scrolling portrait card can land a heading just above the pinned action bar with none of its content in
// view (a "Steps" heading over nothing), so that section moves below the fold, the way print keeps a
// heading with its next line. Measured again when a growing frame reaches the host's cap after first paint.
export function keepHeadsWithContent(root: HTMLElement, s: Pick<Surface, 'orientation'>): number {
  heads = { root, s };
  const card = root.parentElement;
  if (card && !headsObserver && typeof ResizeObserver === 'function') {
    headsObserver = new ResizeObserver(() => {
      if (heads?.root.isConnected) placeHeads(heads.root, heads.s);
    });
    headsObserver.observe(card);
  }
  return placeHeads(root, s);
}

let heads: { root: HTMLElement; s: Pick<Surface, 'orientation'> } | null = null;
let headsObserver: ResizeObserver | null = null;

function placeHeads(root: HTMLElement, s: Pick<Surface, 'orientation'>): number {
  const sections = Array.from(root.querySelectorAll<HTMLElement>('.main-col > .block'));
  for (const section of sections) section.style.removeProperty('margin-top');
  const card = root.parentElement;
  let moved = 0;
  if (card && s.orientation === 'portrait' && card.scrollHeight > card.clientHeight + 1) {
    // Content coordinates: 0 is the top of the scrolled content.
    const origin = card.getBoundingClientRect().top - card.scrollTop;
    const bar = root.querySelector<HTMLElement>(':scope > .action-bar:last-child');
    // At the top of the scroll, a pinned bar covers the bottom of the card.
    const visible = card.clientHeight - (bar ? bar.getBoundingClientRect().height : 0);
    for (const section of sections) {
      const head = section.querySelector<HTMLElement>(':scope > .block-h');
      const body = head?.nextElementSibling;
      if (!head || !body) continue;
      const first = (body.querySelector(':scope > :not(.is-folded)') ?? body).getBoundingClientRect();
      const headTop = head.getBoundingClientRect().top - origin;
      if (headTop < visible && first.bottom - origin > visible) {
        section.style.marginTop = `${Math.ceil(visible - headTop)}px`;
        moved++;
        break;
      }
    }
  }
  root.dataset.kept = String(moved);
  return moved;
}
