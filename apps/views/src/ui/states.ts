import { chip, header } from './components.ts';
import { h } from './dom.ts';
import type { ChipVM } from './vm.ts';

const WORKING: ChipVM = { label: 'Working', tone: 'info', icon: 'clock' };

export type SkeletonShape = 'panel' | 'carousel';

const bone = (cls: string) => h('div', { class: `bone ${cls}` });

/** Holds the coming layout's shape, so nothing jumps when the result arrives. */
function skeleton(shape: SkeletonShape): HTMLElement {
  if (shape === 'carousel') {
    return h('div', { class: 'skeleton skeleton-carousel', attrs: { 'aria-hidden': 'true' } }, bone('bone-card'), bone('bone-card'), bone('bone-card'));
  }
  return h(
    'div',
    { class: 'skeleton skeleton-panel', attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'bone-strip' }, bone('bone-pill'), bone('bone-pill'), bone('bone-pill')),
    h(
      'div',
      { class: 'bone-body' },
      h('div', { class: 'bone-col' }, bone('bone-line is-wide'), bone('bone-bar is-lead'), bone('bone-line'), bone('bone-bar'), bone('bone-line'), bone('bone-bar')),
      bone('bone-card'),
    ),
  );
}

export function waitingScreen(opts: { eyebrow: string; title: string; line: string; shape: SkeletonShape }): HTMLElement {
  return h(
    'div',
    { class: 'panel is-waiting' },
    header({ eyebrow: opts.eyebrow, title: opts.title, chip: WORKING, simulated: false, titleId: 'view-title' }),
    h('p', { class: 'waiting-line', attrs: { role: 'status' } }, h('span', { class: 'pulse', attrs: { 'aria-hidden': 'true' } }), opts.line),
    skeleton(opts.shape),
  );
}

export function messageScreen(opts: { eyebrow: string; title: string; text: string; chip: ChipVM }): HTMLElement {
  return h(
    'div',
    { class: 'panel is-message' },
    header({ eyebrow: opts.eyebrow, title: opts.title, chip: opts.chip, simulated: false, titleId: 'view-title' }),
    h('div', { class: 'message' }, h('p', { class: 'message-text' }, opts.text)),
  );
}

// Voice devices get no view. A host that still shows the frame gets the spoken reply as a caption.
export function voiceScreen(speech: string, status: ChipVM): HTMLElement {
  return h(
    'div',
    { class: 'panel is-voice' },
    h('div', { class: 'hd' }, h('span', { class: 'sr-only' }, 'Spoken reply'), chip(status, 'chip-hero')),
    h('p', { class: 'caption', attrs: { id: 'view-title' } }, speech),
  );
}
