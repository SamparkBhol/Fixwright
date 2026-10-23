// The Home Assistant path: a household linked (ALLOW_HA_LINK=1) to a real Home Assistant 2026.9.4 with
// adapter-ha's hallway circuit fixture. A real power cut brings six devices back on; explain_event names
// the power restore, and the power on behaviour repair is applied and undone with read back on the hub.
// Runs only with FIXWRIGHT_HA=1 (scripts/ha-run.sh starts the hub, runs this file, stops the hub).

import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { createHaAdapter } from '@fixwright/adapter-ha';
import { ToolOutputs } from '@fixwright/protocol';
import { CIRCUIT, powerCut, powerOnSelect, setPowerOnBehavior, setup, type Fixture } from '../../../../packages/adapter-ha/fixtures/home-assistant/inject.ts';
import { SERVER_DIR, startDev, startNtfy, type Dev, type NtfyMock } from '../support/wrangler.ts';

const HA_URL = process.env['HA_URL'] ?? '';
const HA_TOKEN = process.env['HA_TOKEN'] ?? '';
let dev: Dev | undefined;
let ntfy: NtfyMock | undefined;
let fx: Fixture | undefined;

describe('Home Assistant household', { tags: ['ha'] }, () => {
  beforeAll(async () => {
    fx = { adapter: createHaAdapter({ baseUrl: HA_URL, token: HA_TOKEN }), configDir: process.env['HA_CONFIG_DIR'] };
    ntfy = await startNtfy(8706);
    dev = await startDev({ port: 8704, inspector: 8705, name: 'ha', vars: { ALLOW_HA_LINK: '1', NTFY_BASE: ntfy.base, HA_TOKEN_KEY: 'fixwright-test-only-ha-token-key-000001' } });
  });

  afterAll(async () => {
    fx?.adapter.close();
    await dev?.stop();
    await ntfy?.close();
  });

  it('links, explains a real power restore, and fixes the power on behaviour with read back', async () => {
    if (!fx || !dev) throw new Error('setup failed');
    const log: string[] = [];
    await setup(fx);
    await setPowerOnBehavior(fx, 'on');
    // A hub that just booted logs every entity coming up; let that settle so the window holds only this cut.
    await new Promise((r) => setTimeout(r, 10_000));
    const cut = await powerCut(fx, { holdMs: 2000 });
    log.push(`power cut: breaker off ${cut.breakerOffAt}, on ${cut.breakerOnAt}, back on: ${cut.devicesOnAfter.join(', ')}`);
    expect(cut.devicesOnAfter.length).toBeGreaterThanOrEqual(5);

    const post = async (path: string, body: unknown, token?: string) => {
      const r = await fetch(`${dev?.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    const created = await post('/demo/household', {});
    const token = created.json['token'] as string;
    expect((await post('/demo/link-ha', { base_url: HA_URL, token: HA_TOKEN })).status).toBe(403); // never the shared household
    const linked = await post('/demo/link-ha', { base_url: HA_URL, token: HA_TOKEN }, token);
    expect(linked.status, JSON.stringify(linked.json)).toBe(200);
    log.push(`linked: Home Assistant ${String(linked.json['version'])}`);

    const transport = new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      },
    });
    const client = new Client({ name: 'fixwright-ha-test', version: '0.0.0' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'], versionNegotiation: { mode: 'legacy' } });
    await client.connect(transport);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
        expect(r.isError ?? false, `${name}: ${JSON.stringify(r.structuredContent).slice(0, 500)}`).toBe(false);
        const out = r.structuredContent as Record<string, unknown>;
        expect(ToolOutputs[name as keyof typeof ToolOutputs].safeParse(out).success, name).toBe(true);
        expect((out['source'] as { adapter: string; simulated: boolean })).toEqual({ adapter: 'home-assistant', simulated: false });
        return out;
      };
      // The window starts just before this cut: the fixture's own setup (switching everything off through
      // the API) is a user action and would be the answer for a wider window.
      await new Promise((r) => setTimeout(r, 1500));
      const since = new Date(Date.parse(cut.breakerOffAt) - 5_000).toISOString();
      const ex = await call('explain_event', { question: 'Why did the hallway lights turn on by themselves?', since, until: new Date().toISOString() });
      const verdict = ex['verdict'] as { level: string; cause_id: string };
      log.push(`explain_event (${verdict.level} ${verdict.cause_id}): ${String(ex['speech'])}`);
      expect(verdict.cause_id).toBe('power_restore');
      expect(['confirmed', 'likely']).toContain(verdict.level);
      expect(ex['suggested_fix']).toBeTruthy();

      const plan = await call('repair_plan', { explanation_id: ex['explanation_id'] });
      log.push(`repair_plan: ${(plan['diff_lines'] as string[]).join(' ')}`);
      const applied = await call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] });
      log.push(`repair_apply ${String(applied['state'])}: ${String(applied['speech'])}`);
      expect(applied['state']).toBe('applied');
      for (const s of applied['steps'] as { status: string; read_back?: string; label: string }[]) {
        expect(s.status, s.label).toBe('done');
        log.push(`  step ${s.label}: ${s.read_back ?? ''}`);
      }
      // Read the hub directly: every circuit device now remembers its state.
      for (const d of CIRCUIT.devices) expect((await fx.adapter.getEntity(powerOnSelect(d)))?.state, d).toBe('previous');

      const undone = await call('undo', { repair_id: applied['repair_id'] });
      log.push(`undo: ${String(undone['speech'])}`);
      for (const d of CIRCUIT.devices) expect((await fx.adapter.getEntity(powerOnSelect(d)))?.state, d).toBe('on');
    } finally {
      await client.close();
    }
    mkdirSync(`${SERVER_DIR}evidence`, { recursive: true });
    writeFileSync(`${SERVER_DIR}evidence/home-assistant.txt`, `# ${new Date().toISOString()} wrangler dev --local (ALLOW_HA_LINK=1) linked to Home Assistant at ${HA_URL}\n${log.join('\n')}\n`);
  });
});
