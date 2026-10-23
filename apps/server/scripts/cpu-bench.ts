// CPU per request type: bundle the same code wrangler bundles (esbuild, workerd conditions,
// views as text), run it in Node, and read process.cpuUsage() around each request, body drained included.
// Worker and Durable Object time are split: the household runs in process on node:sqlite (the same SQL),
// and its share of each request is measured inside the call, so "worker" is what the Worker isolate spends
// and "do" what the HouseholdDO spends (they are separate invocations with separate CPU limits on Cloudflare).
//
// Usage: node scripts/cpu-bench.ts [iterations=200] [warmup=20]       writes BENCH_CPU.json
//        node scripts/cpu-bench.ts --cold <request>                     (internal: one fresh process)

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { sqliteDb } from '../test/support/sqlite-db.ts';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const OUT = `${SERVER}.wrangler/bench`;
const BUNDLE = `${OUT}/bench-lib.mjs`;
const SECRET = 'bench-secret-bench-secret-bench-0001';
const BASE = 'http://127.0.0.1:8701';

type Lib = typeof import('./bench-entry.ts');

async function bundle(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await build({
    entryPoints: [`${SERVER}scripts/bench-entry.ts`],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    loader: { '.html': 'text' },
    outfile: BUNDLE,
    logLevel: 'error',
  });
}

const cpuMs = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

interface Rig {
  handle: (r: Request) => Promise<Response>;
  /** CPU spent inside household calls during the last request. */
  doMs: { value: number };
  reset(): Promise<void>;
}

async function rig(lib: Lib): Promise<Rig> {
  const households = new Map<string, ReturnType<Lib['createHousehold']>>();
  const doMs = { value: 0 };
  const household = (id: string) => {
    let h = households.get(id);
    if (!h) {
      h = lib.createHousehold(sqliteDb(), id, {
        secret: SECRET,
        ntfyBase: 'http://ntfy.invalid',
        demoStart: '2026-10-15T22:00:00.000Z',
        allowHaLink: false,
        fetch: async () => new Response('{}'),
        setAlarm: async () => {},
      });
      households.set(id, h);
    }
    return h;
  };
  const inDo = async <T>(fn: () => Promise<T>): Promise<T> => {
    const t = cpuMs();
    try {
      return await fn();
    } finally {
      doMs.value += cpuMs() - t;
    }
  };
  const cfg = lib.parseConfig({ CONFIRM_SECRET: SECRET, RATE_MCP_PER_MIN: '100000', RATE_DEMO_PER_MIN: '100000' } as never);
  const handle = lib.createApp(
    {
      tool: (hh, name, input) => inDo(() => household(hh).tool(name, input)),
      demo: (hh, op) => inDo(() => household(hh).demo(op)),
      take: async () => ({ ok: true, remaining: 1 }),
      assets: async () => new Response('not found', { status: 404 }),
    },
    () => cfg,
  );
  // workerd always sets Host from the URL; Node's Request does not, so add it as the platform would.
  const withHost = (req: Request): Request => {
    const headers = new Headers(req.headers);
    headers.set('host', new URL(req.url).host);
    return new Request(req, { headers });
  };
  return { handle: (req) => handle(withHost(req)), doMs, reset: async () => void (await household('hh_public').demo({ op: 'reset' })) };
}

const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
const rpc = (method: string, params?: unknown) => new Request(`${BASE}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }) });
const call = (name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args });

/** Reads an SSE or JSON body and returns the JSON-RPC result. */
async function result(r: Response): Promise<Record<string, unknown>> {
  const text = await r.text();
  const data = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}');
  const msg = JSON.parse(data) as { result?: Record<string, unknown>; error?: unknown };
  if (!msg.result) throw new Error(`no result: ${text.slice(0, 300)}`);
  return msg.result;
}

interface Sample {
  total: number;
  worker: number;
  do: number;
}

/** One golden cycle on a freshly reset house; each request measured on its own. */
async function cycle(r: Rig, record: (type: string, s: Sample) => void): Promise<void> {
  const measure = async (type: string, req: Request, check?: (res: Record<string, unknown>) => void): Promise<Record<string, unknown>> => {
    r.doMs.value = 0;
    const t = cpuMs();
    const res = await r.handle(req);
    // The body is drained inside the measurement (workerd streams it out); decoding it is the client's work.
    const bytes = await res.arrayBuffer();
    const total = cpuMs() - t;
    const body = new TextDecoder().decode(bytes);
    record(type, { total, worker: total - r.doMs.value, do: r.doMs.value });
    if (res.status >= 400) throw new Error(`${type} answered ${res.status}: ${body.slice(0, 200)}`);
    if (!req.url.endsWith('/mcp')) return JSON.parse(body) as Record<string, unknown>;
    const out = await result(new Response(body));
    if (check) check(out);
    return out;
  };
  const sc = (o: Record<string, unknown>) => {
    if (o['isError']) throw new Error(`tool error ${JSON.stringify(o['structuredContent']).slice(0, 200)}`);
    return o['structuredContent'] as Record<string, unknown>;
  };
  await r.reset();
  await measure('initialize', new Request(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: H.accept }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } }) }));
  await measure('tools/list', rpc('tools/list'));
  await measure('resources/read stepper', rpc('resources/read', { uri: 'ui://fixwright/stepper.html' }));
  const dx = sc(await measure('diagnose', call('diagnose', { symptom: "why the hallway lamp keeps saying it's not responding", device: 'hallway lamp' })));
  const q = dx['question'] as { question_id: string };
  sc(await measure('diagnose_answer', call('diagnose_answer', { diagnosis_id: dx['diagnosis_id'], question_id: q.question_id, answer: 'Yes, it blinked.' })));
  const plan = sc(await measure('repair_plan', call('repair_plan', { diagnosis_id: dx['diagnosis_id'] })));
  const applied = sc(await measure('repair_apply', call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] })));
  await measure('repair_status', call('repair_status', { repair_id: applied['repair_id'] }));
  await measure('explain_event', call('explain_event', { question: 'Why did every plug turn on at 3 a.m.?' }));
  await measure('home_checkup', call('home_checkup', {}));
  await measure('switch_device (refused)', call('switch_device', { device: 'living room power strip', on: false }));
  await measure('refresh_view', call('refresh_view', { ref_id: applied['repair_id'] }));
  await measure('/assistant/route', new Request(`${BASE}/assistant/route`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ utterance: 'Give my house a checkup.' }) }));
  await measure('/demo/state', new Request(`${BASE}/demo/state`));
  await measure('/demo/clock next_morning', new Request(`${BASE}/demo/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'next_morning' }) }));
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] as number;
};
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

async function cold(type: string): Promise<void> {
  const t0 = cpuMs();
  const lib = (await import(pathToFileURL(BUNDLE).href)) as Lib;
  const imported = cpuMs() - t0;
  const t1 = cpuMs();
  lib.primeSchemas();
  await lib.warmUp();
  const startup = cpuMs() - t1;
  const r = await rig(lib);
  // First use of the household (SimHome built) happens before the measured request.
  const t2 = cpuMs();
  await r.reset();
  const build = cpuMs() - t2;
  const samples: Record<string, Sample> = {};
  let first = true;
  await cycle(r, (t, s) => {
    if (first || t === type) samples[t] = s;
    first = false;
  }).catch(() => {});
  process.stdout.write(JSON.stringify({ imported, startup, household_build: build, first: samples }));
}

async function main(): Promise<void> {
  if (process.argv[2] === '--cold') return cold(process.argv[3] ?? 'diagnose');
  const loadStart = loadavg().map(r3);
  const iterations = Number(process.argv[2] ?? 200);
  const warmup = Number(process.argv[3] ?? 20);
  await bundle();
  const lib = (await import(pathToFileURL(BUNDLE).href)) as Lib;
  lib.primeSchemas();
  await lib.warmUp();
  const r = await rig(lib);
  const samples = new Map<string, Sample[]>();
  for (let i = 0; i < warmup; i++) await cycle(r, () => {});
  const resetMs: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t = cpuMs();
    await r.reset();
    resetMs.push(cpuMs() - t);
    await cycle(r, (type, s) => {
      const list = samples.get(type) ?? [];
      list.push(s);
      samples.set(type, list);
    });
  }
  const warm: Record<string, unknown> = {};
  for (const [type, list] of samples) {
    const part = (k: keyof Sample) => ({ p50: r3(pct(list.map((s) => s[k]), 50)), p95: r3(pct(list.map((s) => s[k]), 95)), max: r3(Math.max(...list.map((s) => s[k]))) });
    warm[type] = { n: list.length, worker: part('worker'), do: part('do'), total: part('total') };
  }
  // First request in a fresh process (5 processes, median), for the request types that matter most.
  const coldRuns: Record<string, unknown> = {};
  for (const type of ['diagnose', 'tools/list', 'explain_event', 'home_checkup']) {
    const runs = Array.from({ length: 5 }, () => JSON.parse(execFileSync(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--cold', type], { encoding: 'utf8' })) as { imported: number; startup: number; household_build: number; first: Record<string, Sample> });
    const med = (xs: number[]) => r3(pct(xs, 50));
    coldRuns[type] = {
      processes: runs.length,
      module_import_ms: med(runs.map((x) => x.imported)),
      startup_prime_and_warmup_ms: med(runs.map((x) => x.startup)),
      household_first_use_ms: med(runs.map((x) => x.household_build)),
      // The first request of any kind in a fresh Node process; in Node this includes undici's own first use.
      first_initialize_total_ms: med(runs.map((x) => x.first['initialize']?.total ?? NaN)),
      first_request_worker_ms: med(runs.map((x) => x.first[type]?.worker ?? NaN)),
      first_request_do_ms: med(runs.map((x) => x.first[type]?.do ?? NaN)),
    };
  }
  const report = {
    measured_at: new Date().toISOString(),
    method: 'Node process.cpuUsage() around handle(Request) plus body read, esbuild bundle with workerd conditions; household on node:sqlite in process; worker = total minus time inside household calls',
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    loadavg_at_start: loadStart,
    iterations,
    warmup_cycles: warmup,
    warm_ms: warm,
    household_reset_ms: { p50: r3(pct(resetMs, 50)), p95: r3(pct(resetMs, 95)), max: r3(Math.max(...resetMs)) },
    cold_ms: coldRuns,
    loadavg_at_end: loadavg().map(r3),
  };
  writeFileSync(`${SERVER}BENCH_CPU.json`, `${JSON.stringify(report, null, 2)}\n`);
  for (const [type, v] of Object.entries(warm)) {
    const w = v as { worker: { p50: number; p95: number; max: number }; do: { p50: number; p95: number; max: number } };
    console.log(`${type.padEnd(26)} worker p50 ${w.worker.p50} p95 ${w.worker.p95} max ${w.worker.max} | do p50 ${w.do.p50} p95 ${w.do.p95} max ${w.do.max}`);
  }
  console.log(JSON.stringify({ cold: coldRuns, reset: report.household_reset_ms }));
}

await main();
