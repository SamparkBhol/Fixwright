// Text only goes in through text nodes, never innerHTML: every string shown comes from tool results.
import { keepTogether } from './format.ts';

type Child = Node | string | number | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined;

export interface Props {
  class?: string;
  attrs?: Record<string, AttrValue>;
  data?: Record<string, string | number | undefined>;
  style?: Record<string, string>;
  onClick?: () => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props?.class) el.className = props.class;
  for (const [k, v] of Object.entries(props?.attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const [k, v] of Object.entries(props?.data ?? {})) if (v !== undefined) el.dataset[k] = String(v);
  for (const [k, v] of Object.entries(props?.style ?? {})) el.style.setProperty(k, v);
  const onClick = props?.onClick;
  if (onClick) el.addEventListener('click', () => onClick());
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : typeof c === 'string' ? keepTogether(c) : c);
  }
}

export function srOnly(text: string): HTMLSpanElement {
  return h('span', { class: 'sr-only' }, text);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}
