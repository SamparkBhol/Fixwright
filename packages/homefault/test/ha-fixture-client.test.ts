// The Home Assistant fixture client (fixtures/home-assistant/ha-client.ts) against a fake fetch and a fake
// websocket that speak Home Assistant's wire format. The live checks need a real Home Assistant; these pin
// the parts that do not: URLs, auth, batched websocket frames, read-backs and refusals.
import { describe, expect, it } from 'vitest';
import { connectSocket, createHaClient, createRest, type HaState } from '../fixtures/home-assistant/ha-client.ts';

type Call = { url: string; method: string; auth: string | null; body: unknown };

function fakeFetch(handler: (call: Call) => unknown, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      auth: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
}

/** A fake Home Assistant websocket: auth, then echoes results; `onCommand` decides each result. */
function fakeSocket(onCommand: (msg: Record<string, unknown>, push: (frame: unknown) => void) => unknown, token = 'good') {
  const sent: Array<Record<string, unknown>> = [];
  class FakeWs extends EventTarget {
    readonly url: string;
    constructor(url: string) {
      super();
      this.url = url;
      queueMicrotask(() => this.frame({ type: 'auth_required' }));
    }
    frame(data: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
    send(raw: string) {
      const msg = JSON.parse(raw) as Record<string, unknown>;
      sent.push(msg);
      if (msg['type'] === 'auth') {
        queueMicrotask(() => this.frame(msg['access_token'] === token ? { type: 'auth_ok', ha_version: '2026.9.4' } : { type: 'auth_invalid', message: 'bad' }));
        return;
      }
      const result = onCommand(msg, (f) => queueMicrotask(() => this.frame(f)));
      // Home Assistant may coalesce frames into one JSON array; answer that way to cover it.
      queueMicrotask(() => this.frame([{ id: msg['id'], type: 'result', success: true, result }]));
    }
    close() {
      this.dispatchEvent(new Event('close'));
    }
  }
  return { Ctor: FakeWs as unknown as new (url: string) => WebSocket, sent };
}

const state = (entity_id: string, s: string, attributes: Record<string, unknown> = {}): HaState => ({
  entity_id,
  state: s,
  attributes,
  last_changed: '2026-10-15T22:00:00+00:00',
  last_updated: '2026-10-15T22:00:00+00:00',
});

describe('fixture REST client', () => {
  it('sends the bearer token, lower cases entity ids and refuses odd service names', async () => {
    const calls: Call[] = [];
    const rest = createRest({ baseUrl: 'http://ha.test/', token: 't0k', fetch: fakeFetch(() => state('light.a', 'on'), calls) });
    await rest.state('LIGHT.Hallway_Lamp');
    expect(calls[0]).toMatchObject({ url: 'http://ha.test/api/states/light.hallway_lamp', method: 'GET', auth: 'Bearer t0k' });
    await expect(rest.callService('light', 'turn_on; rm', {})).rejects.toThrow(/not a service name/);
    expect(calls).toHaveLength(1);
  });

  it('turns an HTTP error into a thrown error with the status', async () => {
    const rest = createRest({ baseUrl: 'http://ha.test', token: 'x', fetch: fakeFetch(() => new Response('nope', { status: 401 })) });
    await expect(rest.config()).rejects.toThrow(/HTTP 401/);
  });
});

describe('fixture websocket client', () => {
  it('authenticates, runs a command and delivers subscribed events', async () => {
    const { Ctor, sent } = fakeSocket((msg, push) => {
      if (msg['type'] === 'subscribe_events') {
        push({ id: msg['id'], type: 'event', event: { event_type: 'state_changed', data: { entity_id: 'light.a' } } });
        return null;
      }
      return [{ area_id: 'hallway', name: 'Hallway' }];
    });
    const ws = await connectSocket({ baseUrl: 'http://ha.test', token: 'good', WebSocket: Ctor });
    expect(await ws.command('config/area_registry/list')).toEqual([{ area_id: 'hallway', name: 'Hallway' }]);
    const seen: string[] = [];
    const stop = await ws.subscribeEvents<{ entity_id: string }>('state_changed', (e) => seen.push(e.data.entity_id));
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(['light.a']);
    await stop();
    expect(sent.map((m) => m['type'])).toEqual(['auth', 'config/area_registry/list', 'subscribe_events', 'unsubscribe_events']);
    ws.close();
  });

  it('rejects a wrong token', async () => {
    const { Ctor } = fakeSocket(() => null);
    await expect(connectSocket({ baseUrl: 'http://ha.test', token: 'bad', WebSocket: Ctor })).rejects.toThrow(/rejected the token/);
  });
});

describe('fixture client writes read back', () => {
  it('selectOption calls the service once and waits for the state', async () => {
    let current = 'on';
    const calls: Call[] = [];
    const fetchImpl = fakeFetch((c) => {
      if (c.method === 'POST' && c.url.endsWith('/api/services/select/select_option')) {
        current = String((c.body as { option: string }).option);
        return [];
      }
      return state('select.hallway_lamp_power_on_behavior', current, { options: ['off', 'on', 'toggle', 'previous'] });
    }, calls);
    const ha = createHaClient({ baseUrl: 'http://ha.test', token: 'x', fetch: fetchImpl });
    await ha.selectOption('select.hallway_lamp_power_on_behavior', 'previous');
    expect(current).toBe('previous');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    await expect(ha.selectOption('select.hallway_lamp_power_on_behavior', 'sideways')).rejects.toThrow(/no option/);
    await expect(ha.selectOption('lock.front_door', 'previous')).rejects.toThrow(/not a select entity/);
  });

  it('reloadIntegration uses the reload service for a YAML integration with no config entry', async () => {
    const calls: Call[] = [];
    const ha = createHaClient({ baseUrl: 'http://ha.test', token: 'x', fetch: fakeFetch((c) => (c.method === 'GET' ? [] : []), calls) });
    await ha.reloadIntegration('template');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/config/config_entries/entry',
      'POST /api/services/template/reload',
    ]);
  });
});
