// Icons are aria-hidden and never the only signal: the text beside each carries the meaning (guide, Accessibility).

export const ICONS = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  cross: ['M7 7l10 10', 'M17 7L7 17'],
  question: ['M9.1 9.3a3 3 0 1 1 4.3 2.7c-.9.4-1.4 1.1-1.4 2v.6', 'M12 17.8v.01'],
  dash: ['M7 12h10'],
  ask: ['M4.5 5.5h15v10h-8l-4.5 3.8v-3.8h-2.5z'],
  alert: ['M12 4.5l8.5 15h-17z', 'M12 10v4.2', 'M12 17v.01'],
  info: ['M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z', 'M12 11v5.5', 'M12 7.8v.01'],
  half: ['M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z', 'M12 3.5v17'],
  undo: ['M9 14.5L4.5 10L9 5.5', 'M4.5 10h10a5 5 0 0 1 0 10H11'],
  clock: ['M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z', 'M12 7.5V12l3 2'],
  shield: ['M12 3.5l7 2.8v5c0 4.4-3 7.9-7 9.7c-4-1.8-7-5.3-7-9.7v-5z', 'M9 12l2.2 2.2L15.2 10'],
  wrench: ['M14.5 4.2a4.6 4.6 0 0 0-4.9 6.1L4 15.9V20h4.1l5.6-5.6a4.6 4.6 0 0 0 6.1-4.9l-2.8 2.8l-2.9-.8l-.8-2.9z'],
  arrow: ['M5 12h13', 'M13 6.5l5.5 5.5l-5.5 5.5'],
  back: ['M14.5 6l-6 6l6 6'],
  chevron: ['M6.5 9.5l5.5 5.5l5.5-5.5'],
  more: ['M6.5 12h.01', 'M12 12h.01', 'M17.5 12h.01'],
  person: ['M12 4.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7z', 'M5 19.5a7 7 0 0 1 14 0'],
  expand: ['M4.5 9.5v-5h5', 'M19.5 9.5v-5h-5', 'M4.5 14.5v5h5', 'M19.5 14.5v5h-5'],
  collapse: ['M9.5 4.5v5h-5', 'M14.5 4.5v5h5', 'M9.5 19.5v-5h-5', 'M14.5 19.5v-5h5'],
  lock: ['M6.5 11h11v9h-11z', 'M9 11V8a3 3 0 0 1 6 0v3'],
  duplicate_name: ['M3.5 8.5h11v10h-11z', 'M8 5h12.5v10'],
  ghost_entity: ['M6 20V10.5a6 6 0 0 1 12 0V20l-2-1.5l-2 1.5l-2-1.5l-2 1.5l-2-1.5z', 'M10 10.5v.01', 'M14 10.5v.01'],
  flapping: ['M3 9.2a13.5 13.5 0 0 1 18 0', 'M6 12.6a9 9 0 0 1 12 0', 'M9 16a4.5 4.5 0 0 1 6 0', 'M12 19.2v.01'],
  low_battery: ['M3 7.5h15.5v9H3z', 'M21 10.5v3', 'M5.8 10.2v3.6'],
  dead_trigger: ['M13 3L5.5 13.5h5.5l-1 7.5L17.5 10.5H12z'],
  power_on_default: ['M12 3.5v7.5', 'M7 6.6a7.5 7.5 0 1 0 10 0'],
  integration_error: ['M10 14l-1.6 1.6a3.4 3.4 0 0 1-4.8-4.8L5.2 9.2', 'M14 10l1.6-1.6a3.4 3.4 0 0 1 4.8 4.8l-1.6 1.6', 'M8 8L5.5 5.5', 'M16 16l2.5 2.5'],
  unprotected_load: ['M12 3.5l7 2.8v5c0 4.4-3 7.9-7 9.7c-4-1.8-7-5.3-7-9.7v-5z', 'M12 8.5v4.2', 'M12 15.8v.01'],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;

export function isIconName(v: string): v is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, v);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
