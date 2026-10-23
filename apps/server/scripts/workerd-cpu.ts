// Cross check inside the real runtime: CPU time (utime + stime from /proc) of the local
// workerd processes while serving 300 golden path requests in sequence, divided by the request count.
// An upper bound on per request Worker plus Durable Object CPU: it also counts workerd's HTTP parsing,
// wrangler's local proxy worker and request logging, which share these processes locally.
//
// Usage: node scripts/workerd-cpu.ts [requests=300]     (ports 8707 and 8708; writes WORKERD_CPU.json)

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { SERVER_DIR, startDev, startNtfy } from '../test/support/wrangler.ts';

const N = Number(process.argv[2] ?? 300);
const TICK_MS = 1000 / Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());

function groupPids(pgid: number): { pid: number; comm: string }[] {
  const out: { pid: number; comm: string }[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = readFileSync(`/proc/${d}/stat`, 'utf8');
      const comm = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
      const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      if (Number(f[2]) === pgid) out.push({ pid: Number(d), comm });
    } catch {
      /* exited */
    }
  }
  return out;
}

function ticks(pid: number): number {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]);
  } catch {
    return 0;
  }
}

const ntfy = await startNtfy(8709);
const dev = await startDev({
  port: 8707,
  inspector: 8708,
  name: 'cpu',
  vars: { NTFY_BASE: ntfy.base, DEMO_START: '2026-10-15T22:00:00.000Z', RATE_MCP_PER_MIN: '100000', RATE_DEMO_PER_MIN: '100000' },
});
try {
  const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', 'accept-encoding': 'identity' };
  let sent = 0;
  let failed = 0;
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    sent++;
    const r = await fetch(`${dev.base}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const text = await r.text();
    if (r.status >= 400) failed++;
    const data = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}');
    return JSON.parse(data) as Record<string, unknown>;
  };
  const tool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const msg = await post('/mcp', { jsonrpc: '2.0', id: sent, method: 'tools/call', params: { name, arguments: args } });
    const res = msg['result'] as { structuredContent?: Record<string, unknown>; isError?: boolean } | undefined;
    if (!res || res.isError) failed++;
    return res?.structuredContent ?? {};
  };
  const cycle = async (): Promise<void> => {
    await post('/demo/reset', {});
    const dx = await tool('diagnose', { symptom: "why the hallway lamp keeps saying it's not responding", device: 'hallway lamp' });
    const q = dx['question'] as { question_id: string } | undefined;
    await tool('diagnose_answer', { diagnosis_id: dx['diagnosis_id'], question_id: q?.question_id, answer: 'Yes, it blinked.' });
    const plan = await tool('repair_plan', { diagnosis_id: dx['diagnosis_id'] });
    const applied = await tool('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] });
    await post('/demo/clock', { to: 'next_morning' });
    await tool('repair_status', { repair_id: applied['repair_id'] });
    const ex = await tool('explain_event', { question: 'Why did every plug turn on at 3 a.m.?', since: '2026-10-15T10:00:00.000Z', until: '2026-10-15T10:59:59.999Z' });
    const plan2 = await tool('repair_plan', { explanation_id: ex['explanation_id'] });
    const applied2 = await tool('repair_apply', { plan_id: plan2['plan_id'], confirm_token: plan2['confirm_token'] });
    await tool('home_checkup', {});
    await tool('switch_device', { device: 'living room power strip', on: false });
    await tool('protect_device', { device: 'aquarium filter', reason: 'The fish need it running.' });
    await tool('undo', { repair_id: applied2['repair_id'] });
    await tool('refresh_view', { ref_id: applied['repair_id'] });
  };
  // Warm up: two cycles, not counted.
  await cycle();
  await cycle();
  const pids = groupPids(dev.pgid);
  const workerd = pids.filter((p) => p.comm === 'workerd');
  sent = 0;
  failed = 0;
  const before = new Map(pids.map((p) => [p.pid, ticks(p.pid)]));
  const t0 = performance.now();
  let cycles = 0;
  while (sent < N) {
    await cycle();
    cycles++;
  }
  const wall = performance.now() - t0;
  const used = (list: { pid: number }[]) => list.reduce((a, p) => a + ticks(p.pid) - (before.get(p.pid) ?? 0), 0) * TICK_MS;
  const workerdMs = used(workerd);
  const groupMs = used(pids);
  const report = {
    measured_at: new Date().toISOString(),
    method: 'utime+stime of the wrangler dev process group from /proc, golden path cycles (reset, diagnose, answer, plan, apply, next_morning, status, explain, plan, apply, checkup, switch, protect, undo, refresh_view)',
    requests: sent,
    failed,
    cycles,
    tick_ms: TICK_MS,
    wall_ms: Math.round(wall),
    workerd_processes: workerd.length,
    workerd_cpu_ms_total: Math.round(workerdMs),
    workerd_cpu_ms_per_request: Math.round((workerdMs / sent) * 1000) / 1000,
    process_group_cpu_ms_per_request: Math.round((groupMs / sent) * 1000) / 1000,
    loadavg: loadavg().map((x) => Math.round(x * 100) / 100),
  };
  writeFileSync(`${SERVER_DIR}WORKERD_CPU.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await dev.stop();
  await ntfy.close();
}
