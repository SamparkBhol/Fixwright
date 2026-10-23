// Headless onboarding of a fresh Home Assistant over HTTP, then a long lived access token over the
// websocket. Writes { url, token, created_at } to .secrets/ha.json (mode 600, git ignored).
// The account belongs to a throwaway local or CI instance. Run it once against a fresh copy of config/.
// Env: HA_URL (default http://127.0.0.1:8741), HA_START_MS (epoch ms of launch), HA_BOOT_TIMEOUT_MS,
//      HA_SECRETS (default <repository>/.secrets/ha.json).
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectSocket, createRest } from './ha-client.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = (process.env['HA_URL'] ?? 'http://127.0.0.1:8741').replace(/\/+$/, '');
const START_MS = Number(process.env['HA_START_MS'] ?? Date.now());
const BOOT_TIMEOUT_MS = Number(process.env['HA_BOOT_TIMEOUT_MS'] ?? 180_000);
const SECRETS = process.env['HA_SECRETS'] ?? join(PKG, '.secrets', 'ha.json');
const CLIENT_ID = `${BASE}/`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${res.url}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function waitForHttp(): Promise<number> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/`, { signal: AbortSignal.timeout(2000) });
      await res.body?.cancel();
      return res.status;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`no HTTP answer from ${BASE}/api/ within ${BOOT_TIMEOUT_MS} ms`);
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = { url: BASE };
  out['first_http_status'] = await waitForHttp();
  out['first_http_ms_since_launch'] = Date.now() - START_MS;

  const t0 = Date.now();
  const steps = await json<Array<{ step: string; done: boolean }>>(await fetch(`${BASE}/api/onboarding`));
  if (steps.find((s) => s.step === 'user')?.done) {
    throw new Error('this Home Assistant is already onboarded; start it from a fresh copy of the fixture config');
  }
  const password = randomBytes(18).toString('base64url');
  const user = await json<{ auth_code: string }>(
    await fetch(`${BASE}/api/onboarding/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, name: 'Fixture Test', username: 'fixture', password, language: 'en' }),
    }),
  );
  const tok = await json<{ access_token: string }>(
    await fetch(`${BASE}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: user.auth_code, client_id: CLIENT_ID }),
    }),
  );
  const auth = { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' };
  // Order matters: user, core_config, analytics, integration.
  await json(await fetch(`${BASE}/api/onboarding/core_config`, { method: 'POST', headers: auth }));
  await json(await fetch(`${BASE}/api/onboarding/analytics`, { method: 'POST', headers: auth }));
  await json(
    await fetch(`${BASE}/api/onboarding/integration`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ client_id: CLIENT_ID, redirect_uri: `${BASE}/?auth_callback=1` }),
    }),
  );
  out['onboarding_ms'] = Date.now() - t0;

  const t1 = Date.now();
  const ws = await connectSocket({ baseUrl: BASE, token: tok.access_token });
  const llat = await ws.command<string>('auth/long_lived_access_token', { client_name: 'homefault-fixture', lifespan: 30 });
  out['llat_ms'] = Date.now() - t1;

  // Home Assistant 2026.9 migrates the YAML http: block into a PENDING trial config and, unless it is
  // promoted within 5 minutes, reverts to the defaults (port 8123) and restarts. Without a supervisor
  // that restart ends the process. Promote it so the fixture keeps running on its port.
  type HttpConfig = { pending: unknown; revert_at: string | null; active_config_type: string };
  const httpBefore = await ws.command<HttpConfig>('http/config');
  if (httpBefore.pending) await ws.command('http/config/promote');
  const httpAfter = await ws.command<HttpConfig>('http/config');
  if (httpAfter.revert_at !== null) throw new Error(`http config still scheduled to revert at ${httpAfter.revert_at}`);
  out['http_config'] = { was: httpBefore.active_config_type, promoted: !!httpBefore.pending, now: httpAfter.active_config_type };
  ws.close();

  // Wait for core state RUNNING: the HTTP server answers about a second before core finishes starting.
  const rest = createRest({ baseUrl: BASE, token: llat });
  let cfg = await rest.config();
  while (cfg.state !== 'RUNNING' && Date.now() - START_MS < BOOT_TIMEOUT_MS) {
    await sleep(200);
    cfg = await rest.config();
  }
  if (cfg.state !== 'RUNNING') throw new Error(`core state is ${cfg.state}, not RUNNING`);
  out['running_ms_since_launch'] = Date.now() - START_MS;
  out['ha_version'] = cfg.version;

  // The core_config step starts config flows (google_translate, met, radio_browser, shopping_list).
  // Locally (--skip-pip) most fail; in the container they load and use the network. Let them settle,
  // then delete every onboarding sourced entry except shopping_list so both start from one baseline.
  const settleStart = Date.now();
  let last = '';
  let stableSince = Date.now();
  type Entry = { entry_id: string; domain: string; state: string; source: string };
  let entries: Entry[] = [];
  while (Date.now() - settleStart < 15_000) {
    entries = await rest.request<Entry[]>('GET', '/api/config/config_entries/entry');
    const sig = entries
      .filter((e) => e.source === 'onboarding')
      .map((e) => `${e.domain}:${e.state}`)
      .sort()
      .join(',');
    if (sig !== last) {
      last = sig;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 1500) break;
    await sleep(250);
  }
  const removed: string[] = [];
  for (const e of entries.filter((x) => x.source === 'onboarding' && x.domain !== 'shopping_list')) {
    await rest.request('DELETE', `/api/config/config_entries/entry/${e.entry_id}`);
    removed.push(e.domain);
  }
  out['removed_onboarding_entries'] = removed;

  mkdirSync(dirname(SECRETS), { recursive: true, mode: 0o700 });
  writeFileSync(SECRETS, `${JSON.stringify({ url: BASE, token: llat, created_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(SECRETS, 0o600);
  out['secrets'] = SECRETS;
  console.log(JSON.stringify({ onboard: 'ok', ...out }));
}

main().catch((err: unknown) => {
  console.error('onboarding failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
