// Latency of every MCP method as the browser sees it, over N full golden runs on the real local stack, plus
// the workerd CPU those runs cost (from /proc). Each run is a fresh page and a fresh household driven
// through the golden path by the host's test hook; round trips are the host's own Latency tab measurement
// (performance.now() when the request leaves the host to when its response arrives).
//
//   npm run e2e:latency                 50 runs; starts the stack with raised rate limits and stops it
//   RUNS=10 npm run e2e:latency
// Writes docs/integration/LATENCY.json.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUN_DIR = execFileSync('bash', ['-c', `source '${ROOT}scripts/env.sh' && printf %s "$FIXWRIGHT_RUN"`], { encoding: 'utf8' });
const SERVER = 'http://127.0.0.1:8701';
const RUNS = Number(process.env['RUNS'] ?? 50);
const OUT = `${ROOT}docs/integration/LATENCY.json`;
const CLK_TCK = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) || 100;

interface Row {
  lane: string;
  dir: string;
  kind: string;
  method: string;
  tool: string | null;
  id: string | number | null;
  t: number;
  session: number;
}

const EXPECT: [string, string][] = [
  ["Alexa, ask Fixwright why the hallway lamp keeps saying it's not responding.", "Your hub is reachable, the signal is good and the light maker's cloud is fine. I'll flash the hallway lamp twice. Did it blink?"],
];

function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? Number.NaN;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** The same pairing as the host's Latency tab: request out, response in, per session and id. */
function roundTrips(rows: Row[]): Map<string, number[]> {
  const open = new Map<string, Row>();
  const out = new Map<string, number[]>();
  for (const e of rows) {
    if (e.lane !== 'mcp' || e.id === null) continue;
    const key = `${e.session}:${String(e.id)}`;
    if (e.kind === 'request' && e.dir === 'out') open.set(key, e);
    else if ((e.kind === 'response' || e.kind === 'error') && e.dir === 'in') {
      const req = open.get(key);
      if (!req) continue;
      open.delete(key);
      const m = req.method === 'tools/call' && req.tool ? `tools/call ${req.tool}` : req.method;
      out.set(m, [...(out.get(m) ?? []), e.t - req.t]);
    }
  }
  return out;
}

/** utime + stime in ms of every process in a process group, by command name. */
function groupCpuMs(pgid: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${d}/stat`, 'utf8');
    } catch {
      continue;
    }
    const close = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const f = stat.slice(close + 2).split(' ');
    // After "pid (comm) ": state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime
    if (Number(f[2]) !== pgid) continue;
    const ms = ((Number(f[11]) + Number(f[12])) * 1000) / CLK_TCK;
    out[comm] = (out[comm] ?? 0) + ms;
  }
  return out;
}

async function goldenRun(browser: Browser, i: number): Promise<{ trips: Map<string, number[]>; requests: number; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  let requests = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => errors.push(`failed ${r.url()}`));
  page.on('request', (r) => {
    if (r.url().startsWith(SERVER)) requests++;
  });
  await page.goto(`${SERVER}/?test=1`);
  const hook = <T>(fn: string, ...args: unknown[]): Promise<T> =>
    page.evaluate(
      async ([name, a]) => {
        const h = (window as unknown as { __fixwright: Record<string, (...x: unknown[]) => unknown> }).__fixwright;
        return (await h[name as string]?.(...(a as unknown[]))) as unknown;
      },
      [fn, args] as const,
    ) as Promise<T>;
  const say = async (text: string, expectTool: string): Promise<string> => {
    const s = await hook<{ transcript: { tool?: string }[]; spoken: string[] }>('say', text);
    const tool = s.transcript.at(-1)?.tool;
    if (tool !== expectTool) throw new Error(`run ${i}: "${text}" went to ${String(tool)}, not ${expectTool}`);
    return s.spoken.at(-1) ?? '';
  };
  await hook('ready');
  const [first, line] = EXPECT[0] as [string, string];
  if ((await say(first, 'diagnose')) !== line) throw new Error(`run ${i}: diagnose line changed`);
  await hook('setDevice', 'voice');
  await say('Yes, it blinked.', 'diagnose_answer');
  await hook('setDevice', 'large');
  await say('Yes.', 'repair_plan');
  await say('Yes.', 'repair_apply');
  await say('Why did every plug turn on at 3 a.m.?', 'explain_event');
  await say('Yes.', 'repair_plan');
  await say('Yes.', 'repair_apply');
  await hook('setDevice', 'small');
  await say('Give my house a checkup.', 'home_checkup');
  await hook('setDevice', 'phone');
  await say('Turn off the living room power strip.', 'switch_device');
  await hook('setDevice', 'large');
  await hook('setTab', 'house');
  await page.locator('[data-clock="next_morning"]').click();
  for (let k = 0; k < 100 && (await hook<{ pushes: unknown[] }>('snapshot')).pushes.length === 0; k++) await page.waitForTimeout(50);
  await hook('idle');
  await say('Did the fix hold?', 'repair_status');
  const trips = roundTrips(await hook<Row[]>('trace'));
  await context.close();
  return { trips, requests, errors };
}

async function main(): Promise<void> {
  execFileSync('bash', [`${ROOT}scripts/dev-down.sh`], { stdio: 'ignore' });
  execFileSync('bash', [`${ROOT}scripts/dev-up.sh`], { stdio: 'inherit', env: { ...process.env, FIXWRIGHT_RATE_MCP: '100000', FIXWRIGHT_RATE_DEMO: '100000' } });
  const browser = await chromium.launch({ headless: true });
  try {
    const pgid = Number(readFileSync(`${RUN_DIR}/server.pid`, 'utf8').trim());
    // One warm up run (first compile of the Worker and the views in workerd), not counted.
    await goldenRun(browser, 0);
    const all = new Map<string, number[]>();
    const loadBefore = loadavg();
    const cpuBefore = groupCpuMs(pgid);
    const t0 = performance.now();
    let requests = 0;
    const errors: string[] = [];
    const loads: number[] = [];
    for (let i = 1; i <= RUNS; i++) {
      const r = await goldenRun(browser, i);
      for (const [m, xs] of r.trips) all.set(m, [...(all.get(m) ?? []), ...xs]);
      requests += r.requests;
      errors.push(...r.errors);
      loads.push(loadavg()[0] ?? 0);
    }
    const wallS = (performance.now() - t0) / 1000;
    const cpuAfter = groupCpuMs(pgid);
    const loadAfter = loadavg();
    const cpu = Object.fromEntries(Object.keys(cpuAfter).map((k) => [k, r3((cpuAfter[k] ?? 0) - (cpuBefore[k] ?? 0))]));
    const workerdMs = cpu['workerd'] ?? 0;
    const groupMs = Object.values(cpu).reduce((a, b) => a + b, 0);
    const mcpRequests = [...all.values()].reduce((a, xs) => a + xs.length, 0);
    const methods = [...all.entries()]
      .map(([method, xs]) => {
        const s = [...xs].sort((a, b) => a - b);
        return { method, n: s.length, p50_ms: r3(percentile(s, 50)), p95_ms: r3(percentile(s, 95)), max_ms: r3(s.at(-1) ?? Number.NaN) };
      })
      .sort((a, b) => a.method.localeCompare(b.method));
    const report = {
      measured_at: new Date().toISOString(),
      what: 'MCP round trips in the browser (host Latency tab method), full golden runs on wrangler dev --local, fresh page and household per run',
      runs: RUNS,
      warmup_runs: 1,
      wall_s: r3(wallS),
      machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, loadavg_before: loadBefore.map(r3), loadavg_after: loadAfter.map(r3), loadavg1_during_min: r3(Math.min(...loads)), loadavg1_during_max: r3(Math.max(...loads)) },
      methods,
      workerd_cpu: {
        source: `/proc/<pid>/stat utime+stime of the server's process group (CLK_TCK ${CLK_TCK})`,
        by_process_ms: cpu,
        http_requests_from_pages: requests,
        mcp_requests: mcpRequests,
        workerd_ms_per_golden_run: r3(workerdMs / RUNS),
        workerd_ms_per_http_request: r3(workerdMs / Math.max(1, requests)),
        group_ms_per_http_request: r3(groupMs / Math.max(1, requests)),
      },
      console_errors: errors.length,
    };
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${RUNS} runs in ${report.wall_s} s, load ${report.machine.loadavg1_during_min} to ${report.machine.loadavg1_during_max}`);
    for (const m of methods) console.log(`${m.method.padEnd(28)} n ${String(m.n).padStart(4)}  p50 ${m.p50_ms} ms  p95 ${m.p95_ms} ms  max ${m.max_ms} ms`);
    console.log(`workerd CPU: ${report.workerd_cpu.workerd_ms_per_golden_run} ms per golden run, ${report.workerd_cpu.workerd_ms_per_http_request} ms per HTTP request (${requests} requests); console errors ${errors.length}`);
    if (errors.length > 0) console.log(errors.slice(0, 5).join('\n'));
  } finally {
    await browser.close();
    execFileSync('bash', [`${ROOT}scripts/dev-down.sh`], { stdio: 'ignore' });
  }
}

await main();
