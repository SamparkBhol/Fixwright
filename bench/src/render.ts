// What the LLM-only baselines read: the scenario view as plain text. It carries every fact the Fixwright
// engine can reach through scenarioHome(view) (hub, integrations, vendor clouds, every entity with its
// registry flags and signals, every log row), rendered from the raw Home Assistant shaped rows.
// Contexts are resolved the way Home Assistant's logbook shows them: the automation, the user and the
// service behind a change. A row keeps its own user id even when the service call row that carried it
// was dropped by log noise, so the baseline sees at least as much as the engine's adapter does.
// Times are household local time, so the baseline never converts time zones itself. A view holds no
// title, source, ground truth or human truth, so none of it can leak into the text.

import { sortRows, type Entity, type LogRow, type ScenarioView, type Signals } from 'homefault';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Household local date and time: { day: '2026-07-31', time: '22:57:18' }. */
export function localParts(iso: string, tz: string): { day: string; time: string } {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

/** "2026-07-31 22:57:18" in the household's time zone. */
export function localTime(iso: string, tz: string): string {
  const { day, time } = localParts(iso, tz);
  return `${day} ${time}`;
}

const compact = (value: unknown): string => JSON.stringify(value);

function signalText(s: Signals | undefined, now: string, tz: string): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.linkQuality !== undefined) parts.push(`lqi ${s.linkQuality}`);
  if (s.rssi !== undefined) parts.push(`rssi ${s.rssi} dBm`);
  if (s.batteryPct !== undefined) parts.push(`battery ${s.batteryPct}%`);
  if (s.uptimeS !== undefined) parts.push(`uptime ${s.uptimeS} s`);
  if (s.powerOnBehavior !== undefined) parts.push(`power_on_behavior ${s.powerOnBehavior}`);
  if (s.lastSeen !== undefined && s.lastSeen !== now) parts.push(`last seen ${localTime(s.lastSeen, tz)}`);
  if (s.flaps24h !== undefined) parts.push(`drops in 24 h ${s.flaps24h}`);
  return parts.length > 0 ? ` signals: ${parts.join(', ')}` : '';
}

export function entityLine(e: Entity, view: ScenarioView): string {
  const where = [e.domain, e.area, `${e.integration}/${e.transport}`, [e.vendor, e.model].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const flags = [
    e.restored ? 'restored (known to the registry, no longer provided by its integration)' : '',
    e.registryOnly ? 'registry only (not in the state machine)' : '',
    e.disabled ? 'disabled' : '',
  ].filter(Boolean);
  const { friendly_name: _name, ...attrs } = e.attributes;
  const aliases = e.aliases.length > 0 ? ` aliases ${compact(e.aliases)}` : '';
  return [
    `${e.entityId} "${e.name}"${aliases} (${where}) state ${e.state} since ${localTime(e.lastChanged, view.tz)}`,
    flags.length > 0 ? ` [${flags.join('; ')}]` : '',
    Object.keys(attrs).length > 0 ? ` attributes ${compact(attrs)}` : '',
    signalText(Object.hasOwn(view.home.signals, e.entityId) ? view.home.signals[e.entityId] : undefined, view.now, view.tz),
  ].join('');
}

interface Origin {
  automation?: string;
  user?: string;
}

/** Context id -> the automation run and the user behind it, following parent contexts. */
function origins(rows: readonly LogRow[]): Map<string, Origin> {
  const byId = new Map<string, Origin>();
  const parentOf = new Map<string, string>();
  for (const row of rows) {
    const ctx = row.context;
    if (!ctx?.id) continue;
    const o = byId.get(ctx.id) ?? {};
    if (row.type === 'automation_triggered') o.automation = row.entity_id;
    if (ctx.user_id && !o.user) o.user = ctx.user_id;
    byId.set(ctx.id, o);
    if (ctx.parent_id) parentOf.set(ctx.id, ctx.parent_id);
  }
  for (const [id, o] of byId) {
    let parent = parentOf.get(id);
    for (let depth = 0; parent !== undefined && depth < 4; depth++, parent = parentOf.get(parent)) {
      const p = byId.get(parent);
      if (!p) continue;
      o.automation ??= p.automation;
      o.user ??= p.user;
    }
  }
  return byId;
}

/** The service a state change came from: the last call in its context that targeted the entity. */
function serviceFor(rows: readonly LogRow[], index: number, ctxId: string, entityId: string): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const r = rows[i];
    if (r?.type === 'call_service' && r.context?.id === ctxId && r.entity_ids.includes(entityId)) return `${r.domain}.${r.service}`;
  }
  return undefined;
}

function bracket(parts: (string | undefined)[]): string {
  const kept = parts.filter((p): p is string => p !== undefined && p !== '');
  return kept.length > 0 ? ` [${kept.join(', ')}]` : '';
}

/** One logbook line per raw row, without its date (the caller prints a header per day). */
export function rowLine(rows: readonly LogRow[], index: number, byCtx: Map<string, Origin>, tz: string): string {
  const row = rows[index] as LogRow;
  const t = localParts(row.when, tz).time;
  const own = row.context;
  const origin: Origin = { ...(own?.id ? byCtx.get(own.id) : {}) };
  if (own?.user_id) origin.user ??= own.user_id;
  const who = [origin.automation ? `automation ${origin.automation}` : undefined, origin.user ? `user ${origin.user}` : undefined];
  switch (row.type) {
    case 'state': {
      const service = own?.id ? serviceFor(rows, index, own.id, row.entity_id) : undefined;
      const attrs = row.attributes ? ` attributes ${compact(row.attributes)}` : '';
      return `${t} ${row.entity_id} ${row.old_state ?? '?'} -> ${row.state}${attrs}${bracket([...who, service])}`;
    }
    case 'call_service': {
      const data = row.service_data ? ` ${compact(row.service_data)}` : '';
      return `${t} call ${row.domain}.${row.service} ${row.entity_ids.join(', ')}${data}${bracket(who)}`;
    }
    case 'automation_triggered': {
      const name = row.name ? ` "${row.name}"` : '';
      const source = row.source ? ` trigger ${row.source}` : '';
      const error = row.error ? ` error: ${row.error}` : '';
      return `${t} automation ${row.entity_id}${name} triggered${source}${error}${bracket([origin.user ? `user ${origin.user}` : undefined])}`;
    }
    case 'integration':
      return `${t} integration ${row.integration} ${row.old_state ?? '?'} -> ${row.state}${row.reason ? ` reason ${row.reason}` : ''}`;
    case 'registry':
      return `${t} registry ${row.action} ${row.entity_id}${row.changes ? ` ${compact(row.changes)}` : ''}`;
    case 'device_event':
      return `${t} device event ${row.event}${row.entity_id ? ` ${row.entity_id}` : ''}${row.data ? ` ${compact(row.data)}` : ''}`;
  }
}

/** The full text a baseline sees for one scenario. Deterministic: same view, same text. */
export function renderScenarioLog(view: ScenarioView): string {
  const { home } = view;
  const lines: string[] = [];
  lines.push(`Home Assistant ${home.hub.version ?? '(version unknown)'}. Household time zone ${view.tz}. Every time below is household local time.`);
  lines.push(`The person asked at ${localTime(view.now, view.tz)}.`);
  if (view.symptom.device !== undefined) lines.push(`The device the person named: "${view.symptom.device}".`);
  lines.push('');
  lines.push(`hub: ${home.hub.reachable ? 'reachable' : 'NOT reachable'}${home.hub.latencyMs !== undefined ? `, latency ${home.hub.latencyMs} ms` : ''}`);
  lines.push('integrations:');
  for (const i of home.integrations) lines.push(`- ${i.integration}: ${i.state}${i.reason !== undefined ? ` (reason ${i.reason})` : ''}`);
  lines.push('vendor cloud status:');
  if (home.cloud.length === 0) lines.push('- none reported');
  for (const c of home.cloud) lines.push(`- ${c.vendor}: ${c.status} (${c.source}, checked ${localTime(c.checkedAt, view.tz)})`);
  lines.push('');
  lines.push(`entities (${home.entities.length}, state now):`);
  for (const e of [...home.entities].sort((a, b) => a.entityId.localeCompare(b.entityId))) lines.push(entityLine(e, view));
  lines.push('');
  const rows = sortRows(view.events);
  const byCtx = origins(rows);
  lines.push(`logbook (${rows.length} rows, oldest first, grouped by day).`);
  lines.push('Brackets name what started a change: an automation, a user, and the service called. A change with no brackets was not started by any automation, user or service call.');
  let day = '';
  rows.forEach((row, i) => {
    const d = localParts(row.when, view.tz).day;
    if (d !== day) {
      day = d;
      lines.push(`${day}:`);
    }
    lines.push(rowLine(rows, i, byCtx, view.tz));
  });
  return lines.join('\n') + '\n';
}
