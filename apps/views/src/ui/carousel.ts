import { button, errorLine, header, type ActionState } from './components.ts';
import type { Surface } from './context.ts';
import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { modeToggle } from './panel.ts';
import type { CarouselVM, FindingVM } from './vm.ts';

const SEVERITY_ICON: Record<FindingVM['severity'], IconName> = { high: 'alert', medium: 'info', low: 'info' };

export interface CarouselOptions {
  surface: Surface;
  actions: ActionState;
  error: { key: string; text: string } | null;
  onToggleMode?: () => void;
}

function item(f: FindingVM, i: number, o: CarouselOptions): HTMLLIElement {
  const titleId = `finding-${i}`;
  const err = o.error?.key === f.key ? o.error.text : null;
  return h(
    'li',
    {
      class: `item rise tone-${f.tone} ${f.fixed ? 'is-fixed' : ''}`.trim(),
      // Focusable by script only: Back from a fix returns focus here when the card has no button left.
      attrs: { 'aria-labelledby': titleId, tabindex: -1 },
      data: { issue: f.key, severity: f.severity, kind: f.kind },
      style: { 'animation-delay': `${i * 50}ms` },
    },
    h(
      'div',
      { class: 'item-head' },
      h('span', { class: 'sev' }, icon(f.fixed ? 'check' : SEVERITY_ICON[f.severity]), h('span', null, f.severityLabel)),
      h('span', { class: 'kind-icon' }, icon(f.icon)),
    ),
    h('h2', { class: 'item-title', attrs: { id: titleId } }, f.title),
    // A failed action's message takes the detail's place, so the card keeps its head, title and button in
    // view at every size; the detail comes back with the next try.
    err ? errorLine(err) : h('p', { class: 'item-detail' }, f.detail),
    f.action ? h('div', { class: 'item-action' }, button(f.action, o.actions)) : null,
    // The answer is spoken in the conversation, so the card says so where the action was.
    f.asked ? note('ask', ASKED) : null,
    // Nothing Fixwright can change from here (a battery to swap): say so where the action would be.
    !f.action && !f.fixed && !f.asked ? note('person', NEEDS_YOU) : null,
  );
}

function note(name: IconName, text: string): HTMLParagraphElement {
  return h('p', { class: 'item-note', attrs: { role: name === 'ask' ? 'status' : null } }, icon(name, 'icon item-note-icon'), h('span', null, text));
}

export const NEEDS_YOU = 'Needs your hands';
export const ASKED = 'Asked in the conversation';

export function renderCarousel(vm: CarouselVM, o: CarouselOptions): HTMLElement {
  return h(
    'div',
    { class: 'panel carousel' },
    header({
      eyebrow: vm.eyebrow,
      title: vm.title,
      chip: vm.chip,
      simulated: vm.simulated,
      hub: vm.hub,
      titleId: 'view-title',
      side: modeToggle(o.surface, o.onToggleMode),
    }),
    vm.items.length
      ? h('ul', { class: 'track', attrs: { 'aria-label': 'Findings' }, data: { count: vm.items.length } }, ...vm.items.map((f, i) => item(f, i, o)))
      : h('div', { class: 'message' }, h('p', { class: 'message-text' }, 'Nothing needs your attention right now.')),
  );
}

// No title is ever cut: the whole row steps down one type size together, one hierarchy across cards. The row
// takes keyboard focus when it scrolls, so cards without a button stay reachable (guide, Accessibility).
export function fitCarousel(root: ParentNode, s: Pick<Surface, 'orientation' | 'displayMode'>): void {
  const track = root.querySelector<HTMLElement>('.track');
  if (!track) return;
  const items = Array.from(track.querySelectorAll<HTMLElement>('.item'));
  track.classList.remove('is-compact');
  for (const it of items) it.style.removeProperty('--detail-lines');
  if (s.orientation === 'landscape' && s.displayMode === 'inline') {
    const cut = (el: HTMLElement | null) => Boolean(el && el.scrollHeight > el.clientHeight + 1);
    if (items.some((it) => cut(it.querySelector<HTMLElement>('.item-title')))) track.classList.add('is-compact');
    for (const it of items) fitDetail(it);
  }
  if (track.scrollWidth > track.clientWidth + 1) track.setAttribute('tabindex', '0');
  else track.removeAttribute('tabindex');
}

function fitDetail(item: HTMLElement): void {
  const head = item.querySelector<HTMLElement>('.item-head');
  const title = item.querySelector<HTMLElement>('.item-title');
  const detail = item.querySelector<HTMLElement>('.item-detail');
  const last = item.lastElementChild as HTMLElement | null;
  if (!head || !title || !detail || !last || last === detail) return;
  // One unit system throughout (offset px inside the zoomed stage), so the root zoom cancels out.
  const gap = title.offsetTop - (head.offsetTop + head.offsetHeight);
  item.style.setProperty('--detail-lines', '1');
  const line = detail.offsetHeight;
  if (line <= 0) return;
  let between = 0;
  for (let el = detail.nextElementSibling as HTMLElement | null; el && el !== last; el = el.nextElementSibling as HTMLElement | null) between += el.offsetHeight + gap;
  const room = last.offsetTop - gap - between - detail.offsetTop;
  const lines = Math.floor((room + 1) / line);
  item.style.setProperty('--detail-lines', String(Math.max(1, Math.min(8, lines))));
}

// focus with preventScroll leaves the row where a render put it, so it scrolls sideways here, touching
// nothing that scrolls up and down. offsetLeft, scrollLeft and clientWidth share the zoomed row's units.
export function revealInRow(item: HTMLElement): void {
  const row = item.parentElement;
  if (!row || !row.classList.contains('track') || row.scrollWidth <= row.clientWidth + 1) return;
  const pad = parseFloat(getComputedStyle(row).scrollPaddingLeft) || 0;
  const start = item.offsetLeft - pad;
  const end = item.offsetLeft + item.offsetWidth - row.clientWidth + pad;
  if (row.scrollLeft > start) row.scrollLeft = start;
  else if (row.scrollLeft < end) row.scrollLeft = Math.min(start, end);
}
