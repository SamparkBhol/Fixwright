// Tone always comes with text or an icon shape, never color alone (guide, Accessibility).
import { h, srOnly } from './dom.ts';
import { FOLD_MIN } from './fold.ts';
import { evidenceLabel } from './format.ts';
import { icon, type IconName } from './icons.ts';
import type { ActionVM, BlockVM, ChipVM, DecisionVM, Tone } from './vm.ts';

export interface ActionState {
  pending: string | null;
  press(a: ActionVM): void;
}

export function chip(c: ChipVM, extra = ''): HTMLSpanElement {
  return h('span', { class: `chip tone-${c.tone} ${extra}`.trim() }, icon(c.icon, 'icon chip-icon'), h('span', { class: 'chip-label' }, c.label));
}

export function simulatedTag(): HTMLSpanElement {
  return h('span', { class: 'tag', attrs: { title: 'This home is a simulation, not a real house' } }, 'Simulated home');
}

export function hubTag(label: string): HTMLSpanElement {
  return h('span', { class: 'tag tag-live', attrs: { title: 'This ran on a real hub, not on a simulation' } }, label);
}

// apps/host passes its own words for its test hub, whose devices are demo fixtures.
export function hubOf(source: { adapter?: string; simulated: boolean }, hubLabel?: string | null): string | undefined {
  if (source.simulated || source.adapter !== 'home-assistant') return undefined;
  return hubLabel ?? 'Real Home Assistant';
}

export function header(opts: {
  eyebrow: string;
  title: string;
  chip: ChipVM;
  simulated: boolean;
  hub?: string | undefined;
  titleId: string;
  side?: Node | null;
}): HTMLElement {
  return h(
    'header',
    { class: 'hd' },
    h(
      'div',
      { class: 'hd-text' },
      h('p', { class: 'eyebrow' }, h('span', null, opts.eyebrow), opts.simulated ? simulatedTag() : opts.hub ? hubTag(opts.hub) : null),
      h('h1', { class: 'title', attrs: { id: opts.titleId, tabindex: -1 } }, opts.title),
    ),
    h('div', { class: 'hd-side' }, chip(opts.chip, 'chip-hero'), opts.side ?? null),
  );
}

export function button(a: ActionVM, s: ActionState, extraClass = ''): HTMLButtonElement {
  const pending = s.pending === a.id;
  const blocked = s.pending !== null && !pending;
  const el = h(
    'button',
    {
      class: `btn btn-${a.style} ${pending ? 'is-pending' : ''} ${extraClass}`.trim(),
      attrs: { type: 'button', 'aria-busy': pending ? 'true' : null, 'aria-disabled': pending || blocked ? 'true' : null },
      data: { action: a.id },
    },
    pending ? h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }) : null,
    h('span', { class: 'btn-label' }, pending ? a.pendingLabel : a.label),
  );
  el.addEventListener('click', () => {
    if (el.getAttribute('aria-disabled') === 'true') return;
    s.press(a);
  });
  return el;
}

export function iconButton(label: string, name: IconName, onPress: () => void, id: string): HTMLButtonElement {
  return h(
    'button',
    { class: 'btn btn-icon', attrs: { type: 'button', 'aria-label': label, title: label }, data: { action: id }, onClick: onPress },
    icon(name),
  );
}

function blockHeading(text: string, id: string): HTMLHeadingElement {
  return h('h2', { class: 'block-h', attrs: { id } }, text);
}

// A probe that "fails" ran fine and found the problem, so it reads as a finding (amber, alert), never as a
// check that broke (red cross). Red stays for repairs that did not work.
const OUTCOME_ICON: Record<'pass' | 'fail' | 'unknown', IconName> = { pass: 'check', fail: 'alert', unknown: 'question' };
const OUTCOME_TONE: Record<'pass' | 'fail' | 'unknown', Tone> = { pass: 'pass', fail: 'warn', unknown: 'neutral' };

// Passes fold into one "N checks passed" chip when the row would wrap. If it still wraps, the problems fold
// into one "N issues found" chip too; unknowns and the person's answers always stay.
export function probeStrip(b: Extract<BlockVM, { type: 'probes' }>, max: number, idBase: string): HTMLElement {
  const shown = b.items.slice(0, max);
  const more = b.items.length - shown.length;
  const foldable = shown.filter((p) => p.outcome === 'pass' && !p.human);
  const issues = shown.filter((p) => p.outcome === 'fail' && !p.human);
  return h(
    'section',
    { class: 'strip', attrs: { 'aria-labelledby': `${idBase}-h` } },
    h('h2', { class: 'sr-only', attrs: { id: `${idBase}-h` } }, b.heading),
    h(
      'ul',
      { class: 'probes' },
      foldable.length > 1
        ? h(
            'li',
            { class: 'probe probe-summary tone-pass' },
            h('span', { class: 'probe-dot' }, icon('check')),
            h('span', { class: 'probe-label' }, `${foldable.length} checks passed`),
            srOnly(`: ${foldable.map((p) => p.label).join(', ')}`),
          )
        : null,
      issues.length > 1
        ? h(
            'li',
            { class: 'probe probe-summary probe-summary-issues tone-warn' },
            h('span', { class: 'probe-dot' }, icon('alert')),
            h('span', { class: 'probe-label' }, `${issues.length} issues found`),
            srOnly(`: ${issues.map((p) => p.label).join(', ')}`),
          )
        : null,
      ...shown.map((p) =>
        h(
          'li',
          {
            class: `probe tone-${OUTCOME_TONE[p.outcome]} ${p.human ? 'is-human' : ''} ${foldable.length > 1 && foldable.includes(p) ? 'is-foldable' : ''} ${issues.length > 1 && issues.includes(p) ? 'is-issue' : ''}`.replace(/\s+/g, ' ').trim(),
            data: { probe: p.key, outcome: p.outcome },
          },
          h('span', { class: 'probe-dot' }, icon(OUTCOME_ICON[p.outcome])),
          // A check that found something says so in words, not only with the amber icon.
          h('span', { class: 'probe-label' }, p.outcome === 'fail' ? `${p.label} issue` : p.label),
          p.outcome === 'fail' ? null : srOnly(`, ${p.outcomeText}`),
        ),
      ),
      more > 0 ? h('li', { class: 'probe probe-more tone-neutral' }, h('span', { class: 'probe-label' }, `+${more} more`)) : null,
    ),
  );
}

export function fitStrips(root: ParentNode): void {
  for (const ul of Array.from(root.querySelectorAll<HTMLElement>('.probes'))) {
    ul.classList.remove('is-folded', 'is-folded-issues');
    const first = ul.querySelector<HTMLElement>('.probe:not(.probe-summary)');
    if (!first || !ul.querySelector('.probe-summary')) continue;
    // Measured before folding: the first chip may be one of the passes that folding hides.
    const row = first.offsetHeight;
    const wraps = (): boolean => ul.offsetHeight > row * 1.5;
    if (wraps() && ul.querySelector('.probe-summary:not(.probe-summary-issues)')) ul.classList.add('is-folded');
    if (wraps() && ul.querySelector('.probe-summary-issues')) ul.classList.add('is-folded-issues');
  }
}

export interface BlockOptions {
  idBase: string;
  /** The previous diagnosis's widths, so the bars visibly move to the new values. */
  barsFrom: Record<string, number> | null;
}

export function block(b: BlockVM, o: BlockOptions): HTMLElement {
  const hid = `${o.idBase}-h`;
  const section = (cls: string, ...children: (Node | null)[]) =>
    h('section', { class: `block block-${cls}`, attrs: { 'aria-labelledby': hid } }, blockHeading(b.heading, hid), ...children);
  switch (b.type) {
    case 'bars':
      return section(
        'bars',
        h(
          'ol',
          { class: 'bars' },
          ...b.items.map((it) => {
            const from = o.barsFrom?.[it.key];
            return h(
              'li',
              { class: `bar tone-${it.tone} ${it.lead ? 'is-lead' : ''}`.trim(), data: { cause: it.key, pct: it.pct } },
              h('div', { class: 'bar-row' }, h('span', { class: 'bar-label' }, it.label), h('span', { class: 'bar-pct' }, `${it.pct}%`)),
              h(
                'div',
                { class: 'bar-track', attrs: { 'aria-hidden': 'true' } },
                h('div', { class: 'bar-fill', style: { '--to': `${it.pct}%`, '--from': `${from ?? 0}%` } }),
              ),
            );
          }),
        ),
      );
    case 'probes':
      return section(
        'probes',
        h(
          'ul',
          { class: 'probe-list' },
          ...b.items.map((p) =>
            h(
              'li',
              { class: `probe-row tone-${OUTCOME_TONE[p.outcome]}` },
              h('span', { class: 'probe-dot' }, icon(OUTCOME_ICON[p.outcome])),
              h(
                'div',
                { class: 'row-text' },
                h('p', { class: 'row-title' }, p.label, srOnly(`, ${p.outcomeText}`)),
                h('p', { class: 'row-sub' }, p.detail),
                p.evidence ? h('p', { class: 'row-meta' }, evidenceLabel(p.evidence)) : null,
              ),
            ),
          ),
        ),
      );
    case 'timeline':
      return section(
        'timeline',
        h(
          'ol',
          { class: 'timeline' },
          ...b.items.map((t) =>
            h(
              'li',
              { class: 'tl-item' },
              h('span', { class: 'tl-dot', attrs: { 'aria-hidden': 'true' } }),
              h('time', { class: 'tl-time' }, t.time),
              h('span', { class: 'tl-label' }, t.label),
            ),
          ),
        ),
      );
    case 'diff':
      return section(
        'diff',
        h(
          'ul',
          { class: 'diff' },
          ...b.lines.map((line) => h('li', { class: 'diff-line' }, icon('arrow', 'icon diff-icon'), h('span', null, line))),
          ...b.conflicts.map((c) => h('li', { class: 'diff-line is-conflict tone-warn' }, icon('lock', 'icon diff-icon'), h('span', null, c))),
        ),
      );
    case 'changes':
      return section(
        'changes',
        h(
          'ul',
          { class: 'changes' },
          ...b.rows.map((r) =>
            h(
              'li',
              { class: 'change' },
              h('p', { class: 'change-entity' }, `${r.entity} ${r.field}`),
              h('p', { class: 'change-values' }, h('span', { class: 'change-from' }, r.from), icon('arrow', 'icon change-icon'), srOnly(' becomes '), h('span', { class: 'change-to' }, r.to)),
            ),
          ),
        ),
      );
    case 'steps':
      return section(
        'steps',
        h(
          'ol',
          { class: 'steps', attrs: { id: `${o.idBase}-list` } },
          ...b.items.map((s, i) =>
            h(
              'li',
              { class: `step status-${s.status}`, data: { step: s.n, status: s.status }, style: { '--i': String(i) } },
              h('span', { class: 'step-mark', attrs: { 'aria-hidden': 'true' } }, stepMark(s.status, s.n)),
              h(
                'div',
                { class: 'row-text' },
                h('p', { class: 'row-title' }, s.label, srOnly(`, ${s.statusText}`)),
                s.readBack ? h('p', { class: 'row-sub step-rb' }, s.readBack) : null,
              ),
            ),
          ),
        ),
        b.items.length >= FOLD_MIN ? foldRow(`${o.idBase}-list`) : null,
      );
    case 'checks':
      return section(
        'checks',
        h(
          'ul',
          { class: 'checks' },
          ...b.items.map((c) =>
            h(
              'li',
              { class: `probe-row tone-${c.result === 'pass' ? 'pass' : 'fail'}` },
              h('span', { class: 'probe-dot' }, icon(c.result === 'pass' ? 'check' : 'cross')),
              h('div', { class: 'row-text' }, h('p', { class: 'row-title' }, c.detail, srOnly(c.result === 'pass' ? ', passed' : ', failed')), h('p', { class: 'row-meta' }, c.when)),
            ),
          ),
        ),
      );
    case 'claims':
      return section(
        'claims',
        h(
          'ul',
          { class: 'claims' },
          ...b.items.map((c) =>
            h(
              'li',
              { class: 'probe-row tone-pass' },
              h('span', { class: 'probe-dot' }, icon('check')),
              h('div', { class: 'row-text' }, h('p', { class: 'row-title' }, c.text), c.evidence ? h('p', { class: 'row-meta' }, `Backed by ${evidenceLabel(c.evidence)}`) : null),
            ),
          ),
        ),
      );
  }
}

/** fold.ts fills this in once the screen is laid out. */
function foldRow(listId: string): HTMLButtonElement {
  return h(
    'button',
    { class: 'steps-more', attrs: { type: 'button', hidden: true, 'aria-expanded': 'false', 'aria-controls': listId }, data: { action: 'steps-more' } },
    h('span', { class: 'steps-more-mark', attrs: { 'aria-hidden': 'true' } }, icon('more')),
    h('span', { class: 'steps-more-label' }),
    icon('chevron', 'icon steps-more-icon'),
  );
}

function stepMark(status: string, n: number): Node {
  switch (status) {
    case 'done':
      return icon('check');
    case 'rolled_back':
      return icon('undo');
    case 'failed':
      return icon('cross');
    case 'skipped':
      return icon('dash');
    default:
      return document.createTextNode(String(n));
  }
}

export interface Outcome {
  error: string | null;
  notice?: string | null;
}

function outcomeLine(o: Outcome): HTMLElement | null {
  if (o.error) return errorLine(o.error);
  return o.notice ? noticeLine(o.notice) : null;
}

export function decisionCard(d: DecisionVM, s: ActionState, outcome: Outcome, idBase: string, opts: { actions?: boolean } = {}): HTMLElement {
  const withActions = opts.actions !== false && d.actions.length > 0;
  return h(
    'section',
    {
      class: `decision tone-${d.tone}`,
      attrs: { 'aria-labelledby': `${idBase}-text` },
      data: { weight: d.emphasis === 'hero' ? 'hero' : 'body' },
    },
    h(
      'div',
      { class: 'decision-head' },
      h('span', { class: 'decision-icon' }, icon(d.icon)),
      h(
        'div',
        { class: 'decision-copy' },
        d.lead ? h('p', { class: 'decision-lead' }, d.lead) : null,
        h('p', { class: 'decision-text', attrs: { id: `${idBase}-text` } }, d.text),
        d.note ? h('p', { class: 'decision-note' }, d.note) : null,
      ),
    ),
    outcomeLine(outcome),
    withActions ? h('div', { class: `actions n-${d.actions.length}` }, ...d.actions.map((a) => button(a, s))) : null,
  );
}

// Portrait pins the actions to the bottom of the scrolling card, so they stay in reach at any frame height.
export function actionBar(d: DecisionVM, s: ActionState, outcome: Outcome): HTMLElement {
  return h(
    'div',
    { class: 'action-bar' },
    outcomeLine(outcome),
    h('div', { class: `actions n-${d.actions.length}` }, ...d.actions.map((a) => button(a, s))),
  );
}

export function errorLine(text: string): HTMLParagraphElement {
  return h('p', { class: 'error', attrs: { role: 'alert' } }, icon('alert', 'icon error-icon'), h('span', null, text));
}

/** role status, not alert: nothing went wrong, the person chose or asked something. */
export function noticeLine(text: string, name: IconName = 'info'): HTMLParagraphElement {
  return h('p', { class: 'notice', attrs: { role: 'status' } }, icon(name, 'icon notice-icon'), h('span', null, text));
}
