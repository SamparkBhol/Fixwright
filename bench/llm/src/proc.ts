// Linux /proc readers for the measurement scripts: which process is the server, how much memory it
// holds, and which ggml CPU backend it actually loaded. Parsers are pure; the *Of(pid) readers do I/O.
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmEndpoint } from './config.ts';
import { round1 } from './estimate.ts';

/** <workspace>/.cache/llm/run, the same default as LLM_RUN_DIR in llm-config.sh. */
export const DEFAULT_RUN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.cache/llm/run');

/** Port of the endpoint, defaulting like a URL would (80 for http). */
export function portOf(endpoint: LlmEndpoint): number {
  const url = new URL(endpoint.baseUrl);
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

/** The pid file start-llm.sh writes for this endpoint's port: $LLM_RUN_DIR/llama-server-<port>.pid. */
export function pidFileFor(endpoint: LlmEndpoint, runDir: string = DEFAULT_RUN_DIR): string {
  return join(runDir, `llama-server-${portOf(endpoint)}.pid`);
}

export interface ProcessMemory {
  /** VmHWM: the peak resident set since the process started. */
  peak_rss_mib: number | null;
  rss_mib: number | null;
  rss_anon_mib: number | null;
  rss_file_mib: number | null;
}

/** Parses the memory lines of /proc/<pid>/status into MiB. */
export function parseMemory(statusText: string): ProcessMemory {
  const mib = (key: string): number | null => {
    const m = statusText.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return m ? round1(Number(m[1]) / 1024) : null;
  };
  return { peak_rss_mib: mib('VmHWM'), rss_mib: mib('VmRSS'), rss_anon_mib: mib('RssAnon'), rss_file_mib: mib('RssFile') };
}

/**
 * File names of the ggml libraries mapped into a process, from /proc/<pid>/maps text, sorted and
 * without duplicates. llama.cpp's prebuilt ships one CPU backend per instruction set level
 * (libggml-cpu-haswell.so, -zen4.so, ...) and maps only the one it picked for this CPU.
 */
export function ggmlLibraries(mapsText: string): string[] {
  const names = new Set<string>();
  for (const line of mapsText.split('\n')) {
    const path = line.trim().split(/\s+/).slice(5).join(' ');
    const name = basename(path);
    if (/^libggml[\w.-]*\.so(\.\d+)*$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

/** The CPU backend variant among the mapped libraries ('haswell' for libggml-cpu-haswell.so), or null. */
export function cpuBackend(libraries: readonly string[]): string | null {
  for (const name of libraries) {
    const m = name.match(/^libggml-cpu-([\w]+)\.so/);
    if (m) return m[1];
  }
  return null;
}

export function memoryOf(pid: number): ProcessMemory {
  return parseMemory(readFileSync(`/proc/${pid}/status`, 'utf8'));
}

export function commandLineOf(pid: number): string[] {
  return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
}

export function ggmlLibrariesOf(pid: number): string[] {
  return ggmlLibraries(readFileSync(`/proc/${pid}/maps`, 'utf8'));
}

/** Reads the server pid from its pid file; throws with a hint when the server was not started by start-llm.sh. */
export function readServerPid(pidFile: string): number {
  let raw: string;
  try {
    raw = readFileSync(pidFile, 'utf8').trim();
  } catch {
    throw new Error(`no pid file at ${pidFile}; start the server with bench/llm/start-llm.sh (same LLM_PORT)`);
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid file ${pidFile} does not hold a pid: '${raw}'`);
  return pid;
}
