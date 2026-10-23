// workerd smoke test: the unmodified HaAdapter inside Cloudflare's runtime (wrangler dev, local mode),
// against the local Home Assistant fixture. The driver (test/integration/workerd.integration.test.ts)
// passes the hub URL as ?ha= and the token in a request header; this Worker is never deployed.
import { EntitySchema, HouseEventSchema } from '@fixwright/protocol';
import { createHaAdapter, isHaError, type WsConnector } from '../src/index.ts';

/** The second way to open a websocket in a Worker: fetch with Upgrade, then accept(). */
const upgradeConnector: WsConnector = async (url) => {
  const res = await fetch(url.replace(/^ws/, 'http'), { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no webSocket on the upgrade response (HTTP ${res.status})`);
  ws.accept();
  return ws;
};

type Step = { ok: boolean; ms: number; detail?: unknown; error?: string };

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/smoke') return new Response('fixwright adapter-ha smoke worker', { status: 200 });
    const base = url.searchParams.get('ha') ?? 'http://127.0.0.1:8741';
    const token = req.headers.get('x-ha-token') ?? '';
    const lamp = 'light.hallway_lamp';
    const steps: Record<string, Step> = {};
    const step = async (name: string, fn: () => Promise<{ ok: boolean; detail?: unknown }>) => {
      const t0 = Date.now();
      try {
        const r = await fn();
        steps[name] = { ok: r.ok, ms: Date.now() - t0, detail: r.detail };
      } catch (err) {
        steps[name] = { ok: false, ms: Date.now() - t0, error: isHaError(err) ? `${err.kind}: ${err.message}` : String(err) };
      }
    };

    const adapter = createHaAdapter({ baseUrl: base, token });
    await step('hubStatus', async () => {
      const hub = await adapter.hubStatus();
      return { ok: hub.reachable && hub.version === '2026.9.4', detail: hub };
    });
    await step('listEntities', async () => {
      const list = await adapter.listEntities();
      const invalid = list.filter((e) => !EntitySchema.safeParse(e).success).map((e) => e.entityId);
      return { ok: list.length > 100 && invalid.length === 0, detail: { count: list.length, invalid } };
    });
    await step('flash with read-back', async () => {
      const seen: string[] = [];
      for (const service of ['turn_on', 'turn_off']) {
        await adapter.callService('light', service, { entity_id: lamp });
        seen.push((await adapter.getEntity(lamp))?.state ?? 'missing');
      }
      return { ok: seen.join(',') === 'on,off', detail: seen };
    });
    await step('events', async () => {
      // The recorder commits once a second (commit_interval 1): give it time to write the flash.
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const since = new Date(Date.now() - 10 * 60_000).toISOString();
      const events = await adapter.events({ since, entityIds: [lamp] });
      const valid = events.every((e) => HouseEventSchema.safeParse(e).success);
      const lampOn = events.some((e) => e.to === 'on' && e.context?.service === 'light.turn_on');
      return { ok: valid && lampOn, detail: { count: events.length, valid, lampOnWithServiceContext: lampOn } };
    });
    await step('signals', async () => {
      const s = await adapter.signals(lamp);
      return { ok: s.linkQuality === 148 && s.powerOnBehavior !== undefined, detail: s };
    });
    await step('registryUpdate rename and reset', async () => {
      const renamed = await adapter.registryUpdate('light.hallway_lamp_old_pairing', { name: 'Hallway Lamp (workerd)' });
      const reset = await adapter.registryUpdate('light.hallway_lamp_old_pairing', { name: null });
      return { ok: renamed.name === 'Hallway Lamp (workerd)' && reset.name === 'Hallway Lamp', detail: [renamed.name, reset.name] };
    });
    await step('selectOption with read-back', async () => {
      const sel = 'select.hallway_lamp_power_on_behavior';
      const before = (await adapter.getEntity(sel))?.state ?? 'on';
      const changed = await adapter.selectOption(sel, before === 'previous' ? 'on' : 'previous');
      const restored = await adapter.selectOption(sel, before);
      return { ok: changed.state !== before && restored.state === before, detail: [before, changed.state, restored.state] };
    });
    await step('integrations', async () => {
      const ints = await adapter.integrations();
      return { ok: ints.some((i) => i.integration === 'demo' && i.state === 'loaded'), detail: ints.length };
    });
    adapter.close();

    await step('fetch-upgrade websocket path', async () => {
      const viaUpgrade = createHaAdapter({ baseUrl: base, token, connector: upgradeConnector });
      try {
        const e = await viaUpgrade.getEntity(lamp);
        return { ok: e?.area === 'Hallway', detail: { area: e?.area } };
      } finally {
        viaUpgrade.close();
      }
    });
    await step('wrong token is an auth error', async () => {
      const wrong = createHaAdapter({ baseUrl: base, token: 'not-a-token', retry: { retries: 0 } });
      try {
        await wrong.listEntities();
        return { ok: false };
      } catch (err) {
        return { ok: isHaError(err) && err.kind === 'auth', detail: isHaError(err) ? err.kind : String(err) };
      } finally {
        wrong.close();
      }
    });

    const ok = Object.values(steps).every((s) => s.ok);
    return Response.json({ ok, runtime: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown', steps }, { status: ok ? 200 : 500 });
  },
};
