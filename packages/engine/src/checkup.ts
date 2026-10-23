// Home checkup: scan the whole home for problems before they bite, and report 3 to 5 findings,
// most severe first. Each finding is backed by a ledger event recording what the scan saw (plus the home
// events behind it), and the fixable ones carry what repair_plan needs.

import {
  SEVERITY_RANK,
  newId,
  speechSafe,
  type Entity,
  type EntityId,
  type Finding,
  type FindingKind,
  type HomeCheckupInput,
  type HomeCheckupOutput,
  type HouseEvent,
  type Severity,
  type Signals,
} from '@fixwright/protocol';
import { checkClaims, phraseLines } from './claims.ts';
import { clone, houseWords, sourceOf } from './common.ts';
import {
  ESSENTIAL_LOAD,
  SWITCHABLE_DOMAINS,
  deadTriggers,
  houseView,
  inferTopology,
  isGhost,
  isGroup,
  isPhysical,
  LOW_BATTERY_PCT,
  objectId,
  powerOnSelect,
  previousOption,
  type HouseView,
} from './house.ts';
import { syncHomeEvents } from './ledger.ts';
import { phrase } from './phrase.ts';
import type { CheckedClaim, CheckupFindingRecord, CheckupSession, EngineDeps } from './types.ts';
import { capitalize, deviceNoun, fold, integrationName, isMakerDescription, joinAnd, lowerName, tokens } from './util/text.ts';
import { DAY_MS, iso, localDayStart, monthDay, sincePhrase } from './util/time.ts';

export const MAX_FINDINGS = 5;
export const FLAPPING_PER_DAY = 5;
const VOICE_DOMAINS: ReadonlySet<string> = new Set([
  'light', 'switch', 'fan', 'cover', 'climate', 'media_player', 'lock', 'vacuum', 'humidifier', 'water_heater', 'scene', 'script',
]);

export interface CheckupResult {
  session: CheckupSession;
  output: HomeCheckupOutput;
}

interface Candidate {
  kind: FindingKind;
  severity: Severity;
  /** Orders findings of the same severity. Higher first. */
  score: number;
  title: string;
  /** The sentence spoken for this finding (without a leading "And"). */
  spoken: string;
  detail: string;
  entityIds: EntityId[];
  homeEvidence: number[];
  facts: Record<string, unknown>;
  fixable: boolean;
  actionLabel?: string;
  repair?: CheckupFindingRecord['repair'];
}

interface Scan {
  deps: EngineDeps;
  house: HouseView;
  events: HouseEvent[];
  signals: Map<EntityId, Signals>;
  nowMs: number;
}

const lastEvent = (events: readonly HouseEvent[], id: EntityId, to?: string): HouseEvent | undefined =>
  [...events].reverse().find((e) => e.entityId === id && (to === undefined || e.to === to));

function describe(e: Entity): string {
  // A house that describes its makers instead of naming them gets no brand from the integration either.
  if (isMakerDescription(e.vendor)) return isGroup(e) ? `a ${deviceNoun(e)} group` : `a ${deviceNoun(e)}`;
  const via = integrationName(e.integration);
  return isGroup(e) ? `a ${via} group` : `a ${via} ${deviceNoun(e)}`;
}

function namesAndGhosts(s: Scan): Candidate[] {
  const out: Candidate[] = [];
  const byName = new Map<string, Entity[]>();
  for (const e of s.house.live) {
    if (!VOICE_DOMAINS.has(e.domain)) continue;
    for (const n of new Set([e.name, ...e.aliases].map(fold))) byName.set(n, [...(byName.get(n) ?? []), e]);
  }
  const ghostsSeen = new Set<EntityId>();
  for (const members of byName.values()) {
    const unique = [...new Set(members)];
    if (unique.length < 2) continue;
    const ghosts = unique.filter((e) => isGhost(e, s.nowMs));
    const live = unique.filter((e) => !isGhost(e, s.nowMs));
    for (const g of ghosts) {
      if (ghostsSeen.has(g.entityId)) continue;
      ghostsSeen.add(g.entityId);
      out.push(ghostCandidate(s, g, live, true));
    }
    if (live.length < 2) continue;
    const name = live[0]?.name ?? '';
    const nouns = new Set(live.map((e) => deviceNoun(e)));
    const noun = nouns.size === 1 ? ([...nouns][0] ?? 'device') : 'device';
    const who = capitalize(joinAnd(live.map(describe)));
    out.push({
      kind: 'duplicate_name',
      severity: 'high',
      score: 90,
      title: phrase('ck_title_duplicate', { count: live.length, noun, name }),
      spoken: `${phrase('ck_title_duplicate', { count: live.length, noun, name })}.`,
      detail: `${who} are ${live.length === 2 ? 'both' : 'all'} called ${name}, so a command can reach the wrong one.`,
      entityIds: live.map((e) => e.entityId),
      homeEvidence: [],
      facts: { name, members: live.map((e) => e.entityId) },
      fixable: true,
      actionLabel: 'Rename one',
      repair: { cause_id: 'name_collision', entity_ids: live.map((e) => e.entityId) },
    });
  }
  for (const e of s.house.live) {
    if (VOICE_DOMAINS.has(e.domain) && isGhost(e, s.nowMs) && !ghostsSeen.has(e.entityId)) out.push(ghostCandidate(s, e, [], false));
  }
  return out;
}

function ghostCandidate(s: Scan, ghost: Entity, twins: Entity[], sharesName: boolean): Candidate {
  const since = Date.parse(ghost.lastChanged);
  const went = lastEvent(s.events, ghost.entityId, 'unavailable');
  return {
    kind: 'ghost_entity',
    severity: sharesName ? 'high' : 'low',
    score: sharesName ? 85 : 20,
    title: phrase('ck_title_ghost', { name: ghost.name }),
    spoken: phrase('ck_say_ghost', { name: ghost.name }),
    detail: `It has been offline ${sincePhrase(since, s.nowMs, s.deps.settings.tz)}.${
      sharesName ? ` Commands for ${ghost.name} can still go to it. Retiring it fixes that.` : ' Retiring it tidies your device list.'
    }`,
    entityIds: [ghost.entityId, ...twins.map((t) => t.entityId)],
    homeEvidence: went ? [went.seq] : [],
    facts: { lastChanged: ghost.lastChanged, offline_since: monthDay(since, s.deps.settings.tz) },
    fixable: true,
    actionLabel: 'Retire it',
    repair: { cause_id: 'stale_duplicate', entity_ids: [ghost.entityId, ...twins.map((t) => t.entityId)] },
  };
}

function batteries(s: Scan): Candidate[] {
  const byDevice = new Map<string, { pct: number; ids: EntityId[]; main?: Entity; battery?: Entity }>();
  for (const e of s.house.live) {
    const fromSignal = s.signals.get(e.entityId)?.batteryPct;
    const isBatterySensor = e.domain === 'sensor' && e.attributes['device_class'] === 'battery' && Number.isFinite(Number(e.state));
    const pct = fromSignal ?? (isBatterySensor ? Number(e.state) : undefined);
    const key = e.deviceId ?? e.entityId;
    const slot = byDevice.get(key) ?? { pct: Infinity, ids: [] };
    if (pct !== undefined) slot.pct = Math.min(slot.pct, pct);
    if (pct !== undefined || isBatterySensor) slot.ids.push(e.entityId);
    if (isBatterySensor) slot.battery = e;
    else if (pct !== undefined) slot.main = e;
    byDevice.set(key, slot);
  }
  const out: Candidate[] = [];
  for (const slot of byDevice.values()) {
    if (!(slot.pct < LOW_BATTERY_PCT)) continue;
    const pct = Math.round(slot.pct);
    const name = slot.main?.name ?? (slot.battery?.name ?? 'Sensor').replace(/\s*battery$/i, '');
    const cls = slot.main?.attributes['device_class'];
    const reports = cls === 'motion' || cls === 'occupancy' ? 'reporting motion' : cls === 'door' || cls === 'opening' || cls === 'window' ? 'reporting when it opens' : 'reporting';
    const ids = [...new Set([...(slot.main ? [slot.main.entityId] : []), ...slot.ids])];
    const reading = slot.battery ? lastEvent(s.events, slot.battery.entityId) : undefined;
    out.push({
      kind: 'low_battery',
      severity: pct < 10 ? 'high' : 'medium',
      score: 80 + (10 - Math.min(pct, 10)),
      title: phrase('ck_title_battery', { name, pct }),
      spoken: capitalize(phrase('ck_say_battery', { name, pct })),
      detail: `At ${pct}% it may stop ${reports} soon.`,
      entityIds: ids,
      homeEvidence: reading ? [reading.seq] : [],
      facts: { battery_pct: pct },
      fixable: false,
    });
  }
  return out;
}

function flapping(s: Scan): Candidate[] {
  const out: Candidate[] = [];
  const todayStart = localDayStart(s.nowMs, s.deps.settings.tz);
  const seenDevices = new Set<string>();
  for (const e of s.house.live) {
    if (!isPhysical(e)) continue;
    const drops = s.events.filter((x) => x.entityId === e.entityId && x.to === 'unavailable' && x.from !== 'unavailable');
    const reported = s.signals.get(e.entityId)?.flaps24h ?? 0;
    const day = Math.max(drops.length, reported);
    if (day < FLAPPING_PER_DAY) continue;
    const key = e.deviceId ?? e.entityId;
    if (seenDevices.has(key)) continue;
    seenDevices.add(key);
    const today = drops.filter((x) => Date.parse(x.ts) >= todayStart).length;
    const allToday = today === day;
    const count = allToday ? today : day;
    const period = allToday ? 'today' : 'in the last day';
    const wifi = e.transport === 'wifi';
    const sig = s.signals.get(e.entityId) ?? {};
    const noun = deviceNoun(e);
    const detail =
      wifi && sig.rssi !== undefined && sig.rssi <= -75
        ? `Its Wi-Fi signal is weak, at ${sig.rssi} dBm. Moving the ${noun} or the router closer usually helps.`
        : !wifi && sig.linkQuality !== undefined && sig.linkQuality < 60
          ? 'Its signal is weak. A plugged in Zigbee device nearby usually helps, because it passes the signal along.'
          : 'Its signal looks fine, so it may be losing power now and then.';
    const params = { name: e.name, count, wifi, period };
    out.push({
      kind: 'flapping',
      severity: count >= 20 ? 'high' : 'medium',
      score: 50 + Math.min(count, 40),
      title: phrase('ck_title_flapping', params),
      spoken: capitalize(phrase('ck_say_flapping', params)),
      detail,
      entityIds: [e.entityId],
      homeEvidence: drops.map((x) => x.seq),
      facts: { drops: count, period, rssi: sig.rssi ?? null, link_quality: sig.linkQuality ?? null },
      fixable: false,
      actionLabel: 'Show me how',
    });
  }
  return out;
}

function triggers(s: Scan): Candidate[] {
  return deadTriggers(s.house).map(({ automation, missing }) => ({
    kind: 'dead_trigger' as const,
    severity: 'high' as const,
    score: 75,
    title: phrase('ck_title_dead_trigger', { name: automation.name }),
    spoken: `${phrase('ck_title_dead_trigger', { name: automation.name })}.`,
    detail: `It still points at ${joinAnd(missing.map((id) => objectId(id).replace(/_/g, ' ')))}, which is gone, so it can't run as meant.`,
    entityIds: [automation.entityId],
    homeEvidence: [],
    facts: { missing },
    fixable: true,
    actionLabel: 'Turn it off',
    repair: { cause_id: 'dead_trigger' as const, entity_ids: [automation.entityId] },
  }));
}

function powerOn(s: Scan): Candidate[] {
  const on = s.house.live.filter((e) => SWITCHABLE_DOMAINS.has(e.domain) && isPhysical(e) && s.signals.get(e.entityId)?.powerOnBehavior === 'on');
  if (on.length === 0) return [];
  const changeable = on.filter((e) => {
    const sel = powerOnSelect(e, s.house);
    return sel !== undefined && previousOption(sel) !== undefined;
  });
  const first = on[0] as Entity;
  return [
    {
      kind: 'power_on_default',
      severity: on.length >= 5 ? 'medium' : 'low',
      score: 30 + Math.min(on.length, 20),
      title: phrase('ck_title_power_on', { count: on.length, name: first.name }),
      spoken: on.length === 1 ? `The ${lowerName(first.name)} turns on after a power cut.` : `${phrase('ck_title_power_on', { count: on.length, name: first.name })}.`,
      detail:
        on.length === 1
          ? 'After a power cut it switches on, even if it was off before.'
          : 'After a power cut they all switch on, even if they were off before.',
      entityIds: on.map((e) => e.entityId),
      homeEvidence: [],
      facts: { power_on_behavior: 'on', count: on.length },
      fixable: changeable.length > 0,
      ...(changeable.length > 0 ? { actionLabel: 'Make them remember', repair: { cause_id: 'power_on_default_on' as const, entity_ids: changeable.map((e) => e.entityId) } } : {}),
    },
  ];
}

async function connections(s: Scan): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const i of await s.deps.adapter.integrations()) {
    if (i.state === 'loaded') continue;
    const auth = i.state === 'setup_error' && /auth|token|credential|login|password|unauthori[sz]ed|reauth|expired|sign in/i.test(i.reason ?? '');
    const members = s.house.live.filter((e) => e.integration === i.integration);
    const name = integrationName(i.integration);
    const first = members[0];
    out.push({
      kind: 'integration_error',
      severity: 'high',
      // A broken connection takes every device on it offline, so it outranks the other high findings.
      score: 95,
      title: phrase('ck_title_integration', { brand: name, auth }),
      spoken: `${phrase('ck_title_integration', { brand: name, auth })}.`,
      detail: auth
        ? `The link to your ${name} account expired, so ${members.length} devices can't be reached. Signing in again from the app brings them back.`
        : `It reports ${i.state.replace(/_/g, ' ')}, so ${members.length} devices can't be reached.`,
      entityIds: members.map((e) => e.entityId).slice(0, 20),
      homeEvidence: [],
      facts: { integration: i.integration, state: i.state, reason: i.reason ?? null },
      fixable: !auth && first !== undefined,
      actionLabel: auth ? 'Show me how' : 'Reconnect',
      ...(!auth && first !== undefined ? { repair: { cause_id: 'hub_down' as const, entity_ids: [first.entityId] } } : {}),
    });
  }
  return out;
}

function unprotected(s: Scan): Candidate[] {
  const topology = s.deps.settings.topology ?? inferTopology(s.house.all);
  const guarded = new Set(s.deps.settings.protected.map((p) => p.entity_id));
  const out: Candidate[] = [];
  for (const strip of topology.strips) {
    for (const o of strip.outlets) {
      if (guarded.has(o.entity_id) || !ESSENTIAL_LOAD.test(fold(o.load))) continue;
      out.push({
        kind: 'unprotected_load',
        severity: 'high',
        score: 82,
        title: phrase('ck_title_unprotected', { load: o.load }),
        spoken: `The ${lowerName(o.load)} is not protected.`,
        detail: `It runs on outlet ${o.outlet} of the ${strip.name}. Protect it and I'll never switch it off.`,
        entityIds: [o.entity_id, strip.entity_id],
        homeEvidence: [],
        facts: { strip: strip.entity_id, outlet: o.outlet, load: o.load },
        fixable: false,
        actionLabel: 'Protect it',
      });
    }
  }
  return out;
}

const FOCUS_KINDS: ReadonlyArray<[RegExp, FindingKind[]]> = [
  [/batter/, ['low_battery']],
  [/wifi|wi fi|network|signal|drop|offline/, ['flapping', 'integration_error']],
  [/name|duplicate|copy|copies|ghost/, ['duplicate_name', 'ghost_entity']],
  [/power|outage|strip|protect/, ['power_on_default', 'unprotected_load']],
  [/automation|routine|trigger/, ['dead_trigger']],
];

function matchesFocus(c: Candidate, focus: string, house: HouseView): boolean {
  const f = fold(focus);
  for (const [re, kinds] of FOCUS_KINDS) if (re.test(f) && kinds.includes(c.kind)) return true;
  const words = tokens(focus).filter((w) => w.length > 2);
  return c.entityIds.some((id) => {
    const e = house.byId.get(id);
    const hay = ` ${fold(`${e?.name ?? ''} ${e?.area ?? ''}`)} `;
    return words.some((w) => hay.includes(` ${w} `));
  });
}

/**
 * Turns "The kitchen plug dropped off" into "And the kitchen plug dropped off". Only articles and counted
 * lines ("Fourteen devices") lose their capital; names ("Hue needs you") keep it.
 */
const andThen = (line: string): string => {
  const first = line.split(' ')[0] ?? '';
  const common = /^(The|A|An|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty|Thirty|Forty|Fifty)$/;
  return common.test(first) ? `And ${line.charAt(0).toLowerCase()}${line.slice(1)}` : `And ${line}`;
};

/** Scans the home and returns the findings (most severe first) plus the session repair_plan reads. */
export async function runCheckup(input: HomeCheckupInput, deps: EngineDeps): Promise<CheckupResult> {
  const nowMs = deps.clock.nowMs();
  const house = houseView(await deps.adapter.listEntities());
  const events = await syncHomeEvents(deps, { since: iso(nowMs - DAY_MS), until: iso(nowMs) });
  const physical = house.live.filter((e) => isPhysical(e));
  const signals = new Map(await Promise.all(physical.map(async (e) => [e.entityId, await deps.adapter.signals(e.entityId)] as const)));
  const scan: Scan = { deps, house, events, signals, nowMs };

  let candidates = [
    ...namesAndGhosts(scan),
    ...batteries(scan),
    ...flapping(scan),
    ...triggers(scan),
    ...powerOn(scan),
    ...(await connections(scan)),
    ...unprotected(scan),
  ];
  if (input.focus !== undefined && input.focus.trim() !== '') {
    const focus = input.focus;
    candidates = candidates.filter((c) => matchesFocus(c, focus, house));
  }
  candidates.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.score - a.score || a.title.localeCompare(b.title));
  const top = candidates.slice(0, MAX_FINDINGS);

  const checkupId = newId('chk', deps.clock, deps.rng);
  const records: CheckupFindingRecord[] = [];
  for (const c of top) {
    const issueId = newId('iss', deps.clock, deps.rng);
    const seq = await deps.ledger.append({
      ts: deps.clock.now(),
      kind: 'probe',
      ...(c.entityIds[0] !== undefined ? { entityId: c.entityIds[0] } : {}),
      source: 'fixwright',
      data: { probe_id: `checkup_${c.kind}`, value: c.kind, checkup_id: checkupId, issue_id: issueId, entity_ids: c.entityIds, ...c.facts },
    });
    const finding: Finding = {
      issue_id: issueId,
      kind: c.kind,
      severity: c.severity,
      title: c.title,
      detail: c.detail,
      entity_ids: c.entityIds,
      fixable: c.fixable,
      ...(c.actionLabel !== undefined ? { action_label: c.actionLabel } : {}),
    };
    records.push({ finding, evidence: [...new Set([...c.homeEvidence, seq])].sort((a, b) => a - b), ...(c.repair ? { repair: c.repair } : {}) });
  }

  const words = houseWords(house);
  const spokenClaims: CheckedClaim[] = top.slice(0, 3).map((c, i) => ({
    text: c.spoken,
    evidence: records[i]?.evidence ?? [],
    kind: 'fact' as const,
    support: { entityIds: c.entityIds },
  }));
  const { kept } = await checkClaims(spokenClaims, deps.ledger, { houseWords: words });
  const said = await phraseLines(kept, deps.phraser, words);
  const lines =
    records.length === 0
      ? [phrase('ck_healthy', {})]
      : [
          phrase('ck_intro', { count: records.length }),
          ...said.map((line, i) => (i === said.length - 1 && i > 0 ? andThen(line) : line)),
          ...(records.length > 3 ? [phrase('ck_more', { count: records.length - 3 })] : []),
        ];

  const session: CheckupSession = { type: 'checkup', version: 1, checkup_id: checkupId, created_at: deps.clock.now(), findings: records };
  const output: HomeCheckupOutput = {
    speech: speechSafe(lines.join(' ')),
    status: 'ok',
    view: 'carousel',
    ids: { checkup_id: checkupId },
    source: sourceOf(deps.adapter),
    checkup_id: checkupId,
    findings: clone(records.map((r) => r.finding)),
  };
  return { session, output };
}
