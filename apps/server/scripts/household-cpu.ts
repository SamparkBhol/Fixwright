// CPU of creating a new household (POST /demo/household: token, Durable Object init, the SimHome house).
// Same method as cpu-bench.ts: the wrangler style esbuild bundle in Node, process.cpuUsage() around each
// request, the household on node:sqlite in process, "do" = time inside the household call.
//
//   create:           before: every first house of an isolate was built with SimHome.create until 17 Oct
//                     2026 (measured through a 14:00 start, which still takes that path).
//   template:         shipped, a 15:00 start: the prebuilt template rebased to today's 15:00 once per
//                     isolate, then copied with each household's own seed; warmTemplate() at module scope.
//   template-nowarm:  the same without warmTemplate().
//
// Usage: node scripts/household-cpu.ts [warm=200]            writes HOUSEHOLD_CPU.json
//        node scripts/household-cpu.ts --cold <variant>        (internal: one fresh process)

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { sqliteDb } from '../test/support/sqlite-db.ts';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const OUT = `${SERVER}.wrangler/bench`;
const BUNDLE = `${OUT}/household-lib.mjs`;
const SECRET = 'bench-secret-bench-secret-bench-0001';
const TEMPLATE_START = '15:00';
const CREATE_START = '14:00';
const TZ = 'America/Los_Angeles';

type Lib = typeof import('./bench-entry.ts');

async function bundle(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const entry = `${OUT}/household-entry.ts`;
  writeFileSync(entry, `export * from '${SERVER}scripts/bench-entry.ts';\n`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    loader: { '.html': 'text' },
    outfile: BUNDLE,
    logLevel: 'error',
    nodePaths: [`${SERVER}node_modules`, `${SERVER}../../node_modules`],
  });
}

const cpuMs = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] as number;
};
const stats = (xs: number[]) => ({ n: xs.length, p50: r3(pct(xs, 50)), p95: r3(pct(xs, 95)), max: r3(Math.max(...xs)) });

interface Sample {
  total: number;
  worker: number;
  do: number;
}

/** The app with in process households; newHousehold() is one POST /demo/household, measured. */
function rig(lib: Lib, demoStart: string) {
  const doMs = { value: 0 };
  const households = new Map<string, ReturnType<Lib['createHousehold']>>();
  const household = (id: string) => {
    let h = households.get(id);
    if (!h) {
      h = lib.createHousehold(sqliteDb(), id, { secret: SECRET, ntfyBase: 'http://ntfy.invalid', demoStart, allowHaLink: false, fetch: async () => new Response('{}'), setAlarm: async () => {} });
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
  const cfg = lib.parseConfig({ CONFIRM_SECRET: SECRET, RATE_MCP_PER_MIN: '100000', RATE_DEMO_PER_MIN: '100000', DEMO_START: demoStart } as never);
  const handle = lib.createApp(
    {
      tool: (hh, name, input) => inDo(() => household(hh).tool(name, input)),
      demo: (hh, op) => inDo(() => household(hh).demo(op)),
      take: async () => ({ ok: true, remaining: 1 }),
      assets: async () => new Response('not found', { status: 404 }),
    },
    () => cfg,
  );
  const newHousehold = async (): Promise<Sample> => {
    doMs.value = 0;
    const t = cpuMs();
    const res = await handle(new Request('http://127.0.0.1:8701/demo/household', { method: 'POST', headers: { host: '127.0.0.1:8701', 'content-type': 'application/json' }, body: '{}' }));
    const body = await res.arrayBuffer();
    const total = cpuMs() - t;
    if (res.status !== 200) throw new Error(`POST /demo/household answered ${res.status}: ${new TextDecoder().decode(body)}`);
    households.clear();
    return { total, worker: total - doMs.value, do: doMs.value };
  };
  return { newHousehold };
}

const startOf = (variant: string): string => (variant.startsWith('create') ? CREATE_START : TEMPLATE_START);

async function cold(variant: string): Promise<void> {
  const t0 = cpuMs();
  const lib = (await import(pathToFileURL(BUNDLE).href)) as Lib;
  const imported = cpuMs() - t0;
  const t1 = cpuMs();
  lib.primeSchemas();
  await lib.warmUp();
  if (variant === 'template') lib.warmTemplate();
  const startup = cpuMs() - t1;
  const r = rig(lib, startOf(variant));
  const a = await r.newHousehold();
  const b = await r.newHousehold();
  const c = await r.newHousehold();
  process.stdout.write(JSON.stringify({ imported, startup, first: a, second: b, third: c }));
}

async function main(): Promise<void> {
  if (process.argv[2] === '--cold') return cold(process.argv[3] ?? 'template');
  const loadStart = loadavg().map(r3);
  const warmN = Number(process.argv[2] ?? 200);
  await bundle();
  const runs = (variant: string) =>
    Array.from({ length: 7 }, () => JSON.parse(execFileSync(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--cold', variant], { encoding: 'utf8' })) as Record<string, number | Sample>);
  const med = (xs: number[]) => r3(pct(xs, 50));
  const num = (x: number | Sample | undefined): number => (typeof x === 'number' ? x : NaN);
  const part = (x: number | Sample | undefined, k: keyof Sample): number => (typeof x === 'object' ? x[k] : NaN);
  const summary = (rs: Record<string, number | Sample>[]) => ({
    import: med(rs.map((x) => num(x['imported']))),
    startup_prime_and_warmup: med(rs.map((x) => num(x['startup']))),
    first_household: { total: med(rs.map((x) => part(x['first'], 'total'))), do: med(rs.map((x) => part(x['first'], 'do'))), worker: med(rs.map((x) => part(x['first'], 'worker'))) },
    second_household: { total: med(rs.map((x) => part(x['second'], 'total'))), do: med(rs.map((x) => part(x['second'], 'do'))), worker: med(rs.map((x) => part(x['second'], 'worker'))) },
    third_household: { total: med(rs.map((x) => part(x['third'], 'total'))), do: med(rs.map((x) => part(x['third'], 'do'))), worker: med(rs.map((x) => part(x['third'], 'worker'))) },
  });
  const coldRuns = { create: summary(runs('create')), template: summary(runs('template')), template_without_module_warm: summary(runs('template-nowarm')) };

  const lib = (await import(pathToFileURL(BUNDLE).href)) as Lib;
  lib.primeSchemas();
  await lib.warmUp();
  lib.warmTemplate();
  const warmRun = async (demoStart: string, miss: boolean): Promise<Sample[]> => {
    const r = rig(lib, demoStart);
    for (let i = 0; i < 20; i++) {
      if (miss) lib.clearTemplates();
      await r.newHousehold();
    }
    const out: Sample[] = [];
    for (let i = 0; i < warmN; i++) {
      if (miss) lib.clearTemplates();
      out.push(await r.newHousehold());
    }
    return out;
  };
  const split = (xs: Sample[]) => ({ total: stats(xs.map((s) => s.total)), do: stats(xs.map((s) => s.do)), worker: stats(xs.map((s) => s.worker)) });
  const warm = {
    create_every_house: split(await warmRun(CREATE_START, true)),
    template_rebase_every_house: split(await warmRun(TEMPLATE_START, true)),
    template_cached_copy: split(await warmRun(TEMPLATE_START, false)),
  };

  const report = {
    measured_at: new Date().toISOString(),
    method:
      'Node process.cpuUsage(), esbuild bundle with workerd conditions (as cpu-bench.ts). Each sample is one POST /demo/household through createApp with the household on node:sqlite (do = time inside the household call, worker = the rest). Cold = a fresh Node process per run, median of 7; startup = what index.ts runs at module scope (primeSchemas, the engine warmUp and, for template, warmTemplate).',
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    loadavg_at_start: loadStart,
    template: { start: lib.DEMO_TEMPLATE.start, bytes: JSON.stringify(lib.DEMO_TEMPLATE).length },
    cold_ms_median_of_7_processes: coldRuns,
    warm_ms: warm,
    loadavg_at_end: loadavg().map(r3),
  };
  writeFileSync(`${SERVER}HOUSEHOLD_CPU.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 1));
}

await main();
