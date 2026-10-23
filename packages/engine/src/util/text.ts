// Text helpers: folding names for matching, and small plain English formatters for speech.

import type { Entity } from '@fixwright/protocol';

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Lower case, no accents, no punctuation, single spaces: "Hallway  Lamp!" and "hallway lamp" fold alike. */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]s\b/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(text: string): string[] {
  const f = fold(text);
  return f === '' ? [] : f.split(' ');
}

/**
 * True when one name is the other plus a copy number ("Hallway Lamp" and "Hallway Lamp 2"), the way
 * Home Assistant names a device that was paired again. "Lamp 1" and "Lamp 2" are different devices.
 */
export function isCopyName(a: string, b: string): boolean {
  const fa = fold(a);
  const fb = fold(b);
  if (fa === fb) return true;
  const copyOf = (longer: string, shorter: string): boolean => {
    if (!longer.startsWith(`${shorter} `)) return false;
    const rest = longer.slice(shorter.length + 1);
    return /^\d+$/.test(rest) && Number(rest) >= 2;
  };
  return copyOf(fa, fb) || copyOf(fb, fa);
}

/** Levenshtein distance, giving up (returning max + 1) once it is sure to exceed max. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

const SYNONYMS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['lamp', 'light', 'bulb', 'lights', 'lamps', 'bulbs', 'batti', 'bulb']),
  new Set(['plug', 'outlet', 'socket', 'plugs', 'outlets', 'sockets']),
  new Set(['tv', 'television', 'telly']),
  new Set(['fridge', 'refrigerator']),
  new Set(['ac', 'aircon', 'air conditioner']),
  new Set(['thermostat', 'heating']),
  new Set(['sensor', 'detector']),
  new Set(['strip', 'powerstrip']),
];

/** "lmap" and "lamp": the same letters with one neighbouring pair swapped. */
function isSwap(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  const [i, j] = diff;
  return diff.length === 2 && i !== undefined && j === i + 1 && a[i] === b[j] && a[j] === b[i];
}

/**
 * Do two folded tokens name the same thing? Synonyms, plurals and typos count: one swapped pair from
 * four letters, any single edit from five ("camp" never becomes "lamp").
 */
export function tokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length > 2 && (a === `${b}s` || b === `${a}s`)) return true;
  for (const group of SYNONYMS) if (group.has(a) && group.has(b)) return true;
  if (a.length >= 4 && isSwap(a, b)) return true;
  if (a.length >= 5 && b.length >= 5 && editDistance(a, b, 1) <= 1) return true;
  return false;
}

const SMALL = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
] as const;
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'] as const;

/** 14 gives "fourteen", 42 gives "forty two". Numbers past 99 stay as digits. */
export function numberWord(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n);
  if (n < 20) return SMALL[n] ?? String(n);
  const t = TENS[Math.floor(n / 10)] ?? '';
  const u = n % 10;
  return u === 0 ? t : `${t} ${SMALL[u] ?? ''}`;
}

export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Words written in capitals (TV, LED) or with inner capitals (iPhone) keep their case. */
const keepsCase = (word: string): boolean => /^[A-Z0-9]{2,}$/.test(word) || /[a-z][A-Z]/.test(word);

/** "Hall Motion Sensor" gives "hall motion sensor", for use inside a sentence. */
export function lowerName(name: string): string {
  return name
    .split(' ')
    .map((w) => (keepsCase(w) ? w : w.toLowerCase()))
    .join(' ');
}

/** A name that ends in a number ("plug 3", "lamp 2") is said like a name, without "the". */
export const isNumberedName = (name: string): boolean => /\s\d+$/.test(name.trim());

/** "the hallway lamp", but "plug 3". Takes the name as it is said inside a sentence. */
export function theName(name: string): string {
  return isNumberedName(name) ? name : `the ${name}`;
}

/** "Hall Motion Sensor" gives "Hall motion sensor", for the start of a sentence or a card title. */
export function sentenceCase(name: string): string {
  return capitalize(lowerName(name));
}

export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** Everyday device words, used to name devices and to spot device mentions in rephrased text. */
export const NOUNS = [
  'lamp', 'light', 'bulb', 'plug', 'outlet', 'socket', 'strip', 'fan', 'sensor', 'thermostat', 'switch', 'heater',
  'filter', 'pump', 'camera', 'lock', 'tv', 'speaker', 'purifier', 'kettle', 'blind', 'blinds', 'shade', 'vacuum',
  'freezer', 'fridge', 'humidifier', 'dehumidifier', 'doorbell', 'bridge', 'hub', 'router', 'lights', 'lamps',
] as const;

const DOMAIN_NOUN: Readonly<Record<string, string>> = {
  light: 'light',
  switch: 'switch',
  fan: 'fan',
  climate: 'thermostat',
  sensor: 'sensor',
  binary_sensor: 'sensor',
  cover: 'blind',
  lock: 'lock',
  camera: 'camera',
  media_player: 'speaker',
  vacuum: 'vacuum',
  automation: 'automation',
};

/** The everyday word for a device: "Hallway Lamp" gives "lamp", "Kitchen Plug" gives "plug". */
export function deviceNoun(entity: Pick<Entity, 'name' | 'domain'>): string {
  const words = tokens(entity.name);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i] ?? '';
    if ((NOUNS as readonly string[]).includes(w)) return w === 'tv' ? 'TV' : w;
  }
  return DOMAIN_NOUN[entity.domain] ?? 'device';
}

/**
 * How to name a plugged in load in a sentence: its device word when it has one ("Reading Lamp" gives "lamp"),
 * else the whole name ("Phone Charger" gives "phone charger").
 */
export function loadNoun(name: string): string {
  const words = tokens(name);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i] ?? '';
    if ((NOUNS as readonly string[]).includes(w)) return w === 'tv' ? 'TV' : w;
  }
  return lowerName(name);
}

const PLURALS: Readonly<Record<string, string>> = { switch: 'switches', lights: 'lights', lamps: 'lamps', blinds: 'blinds' };

/** A spoken name for several things ("hallway lights", "porch plugs"), so it takes "were". */
export function isPluralName(name: string): boolean {
  const last = name.trim().split(/\s+/).at(-1)?.toLowerCase() ?? '';
  return /^[a-z]+[^su']s$/.test(last);
}

export function plural(noun: string, n: number): string {
  if (n === 1) return noun;
  return PLURALS[noun] ?? (noun.endsWith('s') ? noun : `${noun}s`);
}

/** Lower case the first letter of a sentence so it can follow "Most likely,". Names keep their case. */
export function lowerFirst(s: string): string {
  const first = s.split(' ')[0] ?? '';
  return keepsCase(first) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

const BRANDS: ReadonlyArray<[RegExp, string]> = [
  [/hue|signify|philips/i, 'Hue'],
  [/kasa|tp-?link|tapo/i, 'Kasa'],
  [/ecobee/i, 'Ecobee'],
  [/nest|google/i, 'Nest'],
  [/ikea|tradfri/i, 'IKEA'],
  [/tuya|smart ?life/i, 'Tuya'],
  [/aqara/i, 'Aqara'],
  [/ring/i, 'Ring'],
  [/eve/i, 'Eve'],
  [/lifx/i, 'LIFX'],
  [/wyze/i, 'Wyze'],
  [/meross/i, 'Meross'],
  [/shelly/i, 'Shelly'],
  [/sonoff|itead/i, 'Sonoff'],
];

/** A vendor written in lower case, such as "light maker", describes the maker instead of naming a brand. */
export function isMakerDescription(vendor: string | null | undefined): boolean {
  return typeof vendor === 'string' && /^[a-z]+(?: [a-z]+)+$/.test(vendor.trim());
}

/** A short spoken brand for a vendor string: "Philips Hue" gives "Hue", and "light maker" gives "light maker's". */
export function brand(vendor: string): string {
  if (isMakerDescription(vendor)) return `${vendor.trim()}'s`;
  for (const [re, name] of BRANDS) if (re.test(vendor)) return name;
  const first = vendor.trim().split(/\s+/)[0] ?? vendor;
  return capitalize(first);
}

const INTEGRATION_NAMES: Readonly<Record<string, string>> = {
  zigbee2mqtt: 'Zigbee',
  zha: 'Zigbee',
  deconz: 'Zigbee',
  hue: 'Hue',
  kasa: 'Kasa',
  tplink: 'Kasa',
  matter: 'Matter',
  thread: 'Thread',
  zwave_js: 'Z-Wave',
  ecobee: 'Ecobee',
  nest: 'Nest',
  tuya: 'Tuya',
  template: 'template',
  demo: 'demo',
};

/** How an integration is said out loud: zigbee2mqtt gives "Zigbee". */
export function integrationName(integration: string): string {
  return INTEGRATION_NAMES[integration] ?? capitalize(integration.replace(/_/g, ' '));
}

/** Words for a short duration in seconds, rounded up: 3.6 gives "four seconds", 0.2 gives "one second". */
export function secondsPhrase(seconds: number): string {
  const n = Math.max(1, Math.ceil(seconds - 1e-9));
  return `${numberWord(n)} ${n === 1 ? 'second' : 'seconds'}`;
}
