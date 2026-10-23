import { describe, expect, it } from 'vitest';
import { isHaError, type HaError } from '../src/errors.ts';
import { connectSocket, eventData, parseFrame, websocketUrl, type WebSocketLike } from '../src/socket.ts';
import { addEntity, fakeConnector, fakeHome, haState } from './fake-ha.ts';

async function failure(p: Promise<unknown>): Promise<HaError> {
  try {
    await p;
  } catch (err) {
    if (isHaError(err)) return err;
    throw err;
  }
  throw new Error('expected a failure');
}

describe('websocketUrl', () => {
  it('maps http to ws and https to wss under /api/websocket', () => {
    expect(websocketUrl('http://127.0.0.1:8741/')).toBe('ws://127.0.0.1:8741/api/websocket');
    expect(websocketUrl('https://home.example/api')).toBe('wss://home.example/api/websocket');
  });
});

describe('parseFrame and eventData', () => {
  it('accepts single messages, coalesced arrays and binary frames, and ignores junk', () => {
    expect(parseFrame('{"type":"auth_ok"}')).toEqual([{ type: 'auth_ok' }]);
    expect(parseFrame('[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(parseFrame(new TextEncoder().encode('{"id":3}'))).toEqual([{ id: 3 }]);
    expect(parseFrame(new TextEncoder().encode('{"id":4}').buffer)).toEqual([{ id: 4 }]);
    expect(parseFrame('not json')).toEqual([]);
    expect(parseFrame(42)).toEqual([]);
    expect(eventData({ data: 'x' })).toBe('x');
    expect(eventData(null)).toBeUndefined();
  });
});

describe('connectSocket', () => {
  it('authenticates and reports the Home Assistant version', async () => {
    const home = fakeHome();
    const ws = await connectSocket({ baseUrl: 'http://ha.local', token: home.token, connector: fakeConnector(home) });
    expect(ws.isOpen).toBe(true);
    expect(ws.haVersion).toBe('2026.9.4');
    ws.close();
    expect(ws.isOpen).toBe(false);
  });

  it('reports a rejected token as an auth error', async () => {
    const home = fakeHome();
    const err = await failure(connectSocket({ baseUrl: 'http://ha.local', token: 'wrong', connector: fakeConnector(home) }));
    expect(err.kind).toBe('auth');
    expect(err.code).toBe('auth_invalid');
  });

  it('reports a connector that cannot connect as unreachable', async () => {
    const err = await failure(
      connectSocket({
        baseUrl: 'http://ha.local',
        token: 't',
        connector: () => {
          throw new TypeError('connect ECONNREFUSED');
        },
      }),
    );
    expect(err.kind).toBe('unreachable');
  });

  it('times out when the server never finishes the handshake', async () => {
    const silent: WebSocketLike = { send() {}, close() {}, addEventListener() {} };
    const err = await failure(connectSocket({ baseUrl: 'http://ha.local', token: 't', timeoutMs: 20, connector: () => silent }));
    expect(err.kind).toBe('timeout');
  });

  it('numbers commands, resolves results and maps error codes', async () => {
    const home = fakeHome();
    addEntity(home, haState('light.a', 'on'), { platform: 'hue' });
    const ws = await connectSocket({ baseUrl: 'http://ha.local', token: home.token, connector: fakeConnector(home, { coalesce: true }) });
    const entry = await ws.command<{ platform: string }>('config/entity_registry/get', { entity_id: 'light.a' });
    expect(entry.platform).toBe('hue');
    const missing = await failure(ws.command('config/entity_registry/get', { entity_id: 'light.zz' }));
    expect(missing.kind).toBe('not_found');
    expect(missing.code).toBe('not_found');
    const unknown = await failure(ws.command('made/up'));
    expect(unknown.kind).toBe('bad_request');
    ws.close();
  });

  it('gives each command a deadline', async () => {
    const home = fakeHome();
    const ws = await connectSocket({
      baseUrl: 'http://ha.local',
      token: home.token,
      commandTimeoutMs: 25,
      connector: fakeConnector(home, { silent: ['logbook/get_events'] }),
    });
    const err = await failure(ws.command('logbook/get_events', { start_time: 'x' }));
    expect(err.kind).toBe('timeout');
    ws.close();
  });

  it('fails pending commands as unreachable when the socket closes', async () => {
    const home = fakeHome();
    const ws = await connectSocket({ baseUrl: 'http://ha.local', token: home.token, connector: fakeConnector(home, { silent: ['config/device_registry/list'] }) });
    const pending = ws.command('config/device_registry/list');
    home.sockets[0]?.close();
    const err = await failure(pending);
    expect(err.kind).toBe('unreachable');
    expect(ws.isOpen).toBe(false);
    const after = await failure(ws.command('config/area_registry/list'));
    expect(after.kind).toBe('unreachable');
  });

  it('subscribes, delivers events by subscription id and unsubscribes', async () => {
    const listeners: Array<(e: unknown) => void> = [];
    const sent: Array<Record<string, unknown>> = [];
    const push = (m: unknown) => setTimeout(() => listeners.forEach((l) => l({ data: JSON.stringify(m) })), 0);
    const conn: WebSocketLike = {
      addEventListener: (type, l) => {
        if (type === 'message') listeners.push(l);
      },
      send: (d) => {
        const m = JSON.parse(d) as Record<string, unknown>;
        sent.push(m);
        if (m['type'] === 'auth') push({ type: 'auth_ok', ha_version: '2026.9.4' });
        else push({ id: m['id'], type: 'result', success: true, result: null });
      },
      close: () => {},
    };
    push({ type: 'auth_required' });
    const ws = await connectSocket({ baseUrl: 'http://ha.local', token: 't', connector: () => conn });
    const seen: string[] = [];
    const unsubscribe = await ws.subscribeEvents<{ entity_id: string }>('state_changed', (e) => seen.push(e.data.entity_id));
    const subId = sent.find((m) => m['type'] === 'subscribe_events')?.['id'];
    push({ id: subId, type: 'event', event: { event_type: 'state_changed', data: { entity_id: 'light.a' } } });
    push({ id: 999, type: 'event', event: { event_type: 'state_changed', data: { entity_id: 'light.other_sub' } } });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['light.a']);
    await unsubscribe();
    expect(sent.at(-1)).toMatchObject({ type: 'unsubscribe_events', subscription: subId });
    ws.close();
  });
});
