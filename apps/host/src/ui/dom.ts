// A small DOM builder. Text always goes through textContent, never innerHTML, so server text and tool
// results cannot inject markup into the host page.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Inline icons on a 24 px grid, stroked in currentColor. */
export function icon(name: keyof typeof ICONS, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** The device switcher's silhouettes on a 40 by 28 grid, all standing on the same shelf line (y 27). */
export function silhouette(device: 'large' | 'small' | 'phone' | 'voice'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 28');
  svg.setAttribute('width', '40');
  svg.setAttribute('height', '28');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'silhouette');
  for (const d of SILHOUETTES[device]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const SILHOUETTES = {
  large: ['M4 3.5h32a1.5 1.5 0 0 1 1.5 1.5v17a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 22V5A1.5 1.5 0 0 1 4 3.5z', 'M17 23.5h6l2 3.5H15z'],
  small: ['M9.5 11.5h21a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-21A1.5 1.5 0 0 1 8 22v-9a1.5 1.5 0 0 1 1.5-1.5z', 'M18 23.5h4l1.6 3.5h-7.2z'],
  phone: ['M16.5 4.5h7a2.5 2.5 0 0 1 2.5 2.5v17.5a2.5 2.5 0 0 1-2.5 2.5h-7a2.5 2.5 0 0 1-2.5-2.5V7a2.5 2.5 0 0 1 2.5-2.5z'],
  voice: ['M20 12.5c5.2 0 9.5 1.3 9.5 3v8c0 1.9-4.3 3.5-9.5 3.5s-9.5-1.6-9.5-3.5v-8c0-1.7 4.3-3 9.5-3z'],
} as const;

export const ICONS = {
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],
  send: ['M5 12h14', 'M13 6l6 6-6 6'],
  sun: ['M12 4V2', 'M12 22v-2', 'M4 12H2', 'M22 12h-2', 'M5.6 5.6 4.2 4.2', 'M19.8 19.8l-1.4-1.4', 'M5.6 18.4l-1.4 1.4', 'M19.8 4.2l-1.4 1.4', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
  display: ['M3 5h18v12H3z', 'M9 21h6', 'M12 17v4'],
  small: ['M4 7h16v10H4z', 'M10 20h4'],
  phone: ['M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M11 18h2'],
  speaker: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7z'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  reset: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'],
  shield: ['M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z', 'M9 12l2 2 4-4'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8', 'M10 21h4'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  chevron: ['M9 6l6 6-6 6'],
  check: ['M5 12l5 5 9-10'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
} as const;
