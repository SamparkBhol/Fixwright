// What a result file records about the machine and the LLM server, so every number can be traced to
// its settings: llama-server's /props (build, model file, slots, context), its command line and CPU
// backend from /proc (when started by bench/llm/start-llm.sh), and its /metrics counters before and
// after each baseline (measured prompt and generation speed, and a check that no prompt was cached).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, loadavg, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { serverRoot, type LlmEndpoint } from '../llm/src/config.ts';
import { commandLineOf, cpuBackend, ggmlLibrariesOf, memoryOf, pidFileFor, readServerPid } from '../llm/src/proc.ts';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MachineInfo {
  cpu: string;
  vcpus: number;
  total_mem_gib: number;
  node: string;
  load_average: [number, number, number];
}

export function machineInfo(): MachineInfo {
  const c = cpus();
  const [a, b, d] = loadavg();
  return {
    cpu: c[0]?.model.trim() ?? 'unknown',
    vcpus: c.length,
    total_mem_gib: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    node: process.version,
    load_average: [round2(a ?? 0), round2(b ?? 0), round2(d ?? 0)],
  };
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Version of an installed package, read from its own package.json. */
export function installedVersion(pkg: string): string | null {
  try {
    let dir = dirname(createRequire(import.meta.url).resolve(pkg));
    for (let i = 0; i < 6; i++) {
      try {
        const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (json.name === pkg) return json.version ?? null;
      } catch {
        // keep walking up
      }
      dir = dirname(dir);
    }
  } catch {
    return null;
  }
  return null;
}

export interface ServerInfo {
  reachable: boolean;
  error?: string;
  build_info?: string;
  model_alias?: string;
  model_file?: string;
  model_ftype?: string;
  n_params?: number;
  total_slots?: number;
  n_ctx?: number;
  /** llama-server's command line (no secrets: an API key is passed through a file). */
  args?: string[];
  cpu_backend?: string | null;
  peak_rss_mib?: number | null;
}

async function getJson(fetchImpl: FetchLike, url: string, endpoint: LlmEndpoint): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${endpoint.apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

export async function serverInfo(endpoint: LlmEndpoint, fetchImpl: FetchLike = fetch): Promise<ServerInfo> {
  const root = serverRoot(endpoint);
  const info: ServerInfo = { reachable: false };
  try {
    const health = await fetchImpl(`${root}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!health.ok) return { reachable: false, error: `GET /health answered HTTP ${health.status}` };
    info.reachable = true;
    const props = (await getJson(fetchImpl, `${root}/props`, endpoint)) as Record<string, unknown>;
    const dgs = props.default_generation_settings as { n_ctx?: number } | undefined;
    if (typeof props.build_info === 'string') info.build_info = props.build_info;
    if (typeof props.model_alias === 'string') info.model_alias = props.model_alias;
    if (typeof props.model_path === 'string') info.model_file = props.model_path.split('/').pop() as string;
    if (typeof props.model_ftype === 'string') info.model_ftype = props.model_ftype;
    if (typeof props.total_slots === 'number') info.total_slots = props.total_slots;
    if (typeof dgs?.n_ctx === 'number') info.n_ctx = dgs.n_ctx;
    const models = (await getJson(fetchImpl, `${endpoint.baseUrl}/models`, endpoint)) as { data?: { meta?: { n_params?: number } }[] };
    const nParams = models.data?.[0]?.meta?.n_params;
    if (typeof nParams === 'number') info.n_params = nParams;
  } catch (err) {
    info.error = (err as Error).message;
    return info;
  }
  try {
    const pid = readServerPid(pidFileFor(endpoint));
    info.args = commandLineOf(pid).slice(1);
    info.cpu_backend = cpuBackend(ggmlLibrariesOf(pid));
    info.peak_rss_mib = memoryOf(pid).peak_rss_mib;
  } catch {
    // Not started by start-llm.sh on this port: /props above is still recorded.
  }
  return info;
}

export interface ServerCounters {
  prompt_tokens: number;
  prompt_seconds: number;
  prompt_tokens_cached: number;
  predicted_tokens: number;
  predicted_seconds: number;
}

const COUNTERS: Record<keyof ServerCounters, string> = {
  prompt_tokens: 'llamacpp:prompt_tokens_total',
  prompt_seconds: 'llamacpp:prompt_seconds_total',
  prompt_tokens_cached: 'llamacpp:prompt_tokens_cached_total',
  predicted_tokens: 'llamacpp:tokens_predicted_total',
  predicted_seconds: 'llamacpp:tokens_predicted_seconds_total',
};

/** Parses llama-server's Prometheus text. Missing counters read as 0. */
export function parseCounters(text: string): ServerCounters {
  const out = { prompt_tokens: 0, prompt_seconds: 0, prompt_tokens_cached: 0, predicted_tokens: 0, predicted_seconds: 0 };
  for (const [key, name] of Object.entries(COUNTERS) as [keyof ServerCounters, string][]) {
    const m = text.match(new RegExp(`^${name}\\s+([0-9.eE+-]+)\\s*$`, 'm'));
    if (m) out[key] = Number(m[1]);
  }
  return out;
}

export async function serverCounters(endpoint: LlmEndpoint, fetchImpl: FetchLike = fetch): Promise<ServerCounters | null> {
  try {
    const res = await fetchImpl(`${serverRoot(endpoint)}/metrics`, { headers: { authorization: `Bearer ${endpoint.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? parseCounters(await res.text()) : null;
  } catch {
    return null;
  }
}

export interface CounterDelta {
  prompt_tokens: number;
  prompt_tokens_cached: number;
  prompt_tok_per_s: number | null;
  predicted_tokens: number;
  predicted_tok_per_s: number | null;
}

export function counterDelta(before: ServerCounters, after: ServerCounters): CounterDelta {
  const pt = after.prompt_tokens - before.prompt_tokens;
  const ps = after.prompt_seconds - before.prompt_seconds;
  const gt = after.predicted_tokens - before.predicted_tokens;
  const gs = after.predicted_seconds - before.predicted_seconds;
  return {
    prompt_tokens: pt,
    prompt_tokens_cached: after.prompt_tokens_cached - before.prompt_tokens_cached,
    prompt_tok_per_s: ps > 0 ? round2(pt / ps) : null,
    predicted_tokens: gt,
    predicted_tok_per_s: gs > 0 ? round2(gt / gs) : null,
  };
}
