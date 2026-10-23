import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_ENDPOINT, endpointFromEnv } from '../src/config.ts';
import { cpuBackend, DEFAULT_RUN_DIR, ggmlLibraries, parseMemory, pidFileFor, portOf, readServerPid } from '../src/proc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'llm-proc-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MAPS = `5d1c0e400000-5d1c0e401000 r--p 00000000 00:2f 1234 /work/.cache/llm/llama.cpp/llama-b11146/llama-server
7f10a0000000-7f10a0200000 r-xp 00000000 00:2f 2001 /work/.cache/llm/llama.cpp/llama-b11146/libggml-cpu-haswell.so
7f10a0200000-7f10a0300000 r--p 00200000 00:2f 2001 /work/.cache/llm/llama.cpp/llama-b11146/libggml-cpu-haswell.so
7f10a1000000-7f10a1100000 r-xp 00000000 00:2f 2002 /work/.cache/llm/llama.cpp/llama-b11146/libggml-base.so.0.25.1
7f10a2000000-7f10a2100000 r-xp 00000000 00:2f 2003 /work/.cache/llm/llama.cpp/llama-b11146/libllama.so.0.5.0
7f10a3000000-7f10a3001000 rw-p 00000000 00:00 0
7ffd1c000000-7ffd1c021000 rw-p 00000000 00:00 0                          [stack]
`;

describe('ggml backend detection', () => {
  it('lists each mapped ggml library once, sorted, ignoring other mappings', () => {
    expect(ggmlLibraries(MAPS)).toEqual(['libggml-base.so.0.25.1', 'libggml-cpu-haswell.so']);
  });

  it('names the CPU backend variant, or null when none is mapped', () => {
    expect(cpuBackend(ggmlLibraries(MAPS))).toBe('haswell');
    expect(cpuBackend(['libggml-base.so.0.25.1'])).toBeNull();
  });
});

describe('parseMemory', () => {
  it('reads peak and current RSS in MiB', () => {
    const status = 'Name:\tllama-server\nVmHWM:\t12519219 kB\nVmRSS:\t12500000 kB\nRssAnon:\t12483000 kB\nRssFile:\t16179 kB\n';
    expect(parseMemory(status)).toEqual({ peak_rss_mib: 12225.8, rss_mib: 12207, rss_anon_mib: 12190.4, rss_file_mib: 15.8 });
    expect(parseMemory('Name:\tx\n').peak_rss_mib).toBeNull();
  });
});

describe('pid files', () => {
  it('uses one pid file per port under the workspace run dir', () => {
    expect(DEFAULT_RUN_DIR).toBe(resolve(here, '../../../../.cache/llm/run'));
    expect(portOf(DEFAULT_ENDPOINT)).toBe(8771);
    expect(pidFileFor(DEFAULT_ENDPOINT)).toBe(join(DEFAULT_RUN_DIR, 'llama-server-8771.pid'));
    expect(pidFileFor(endpointFromEnv({ LLM_PORT: '8772' }), '/run/x')).toBe('/run/x/llama-server-8772.pid');
  });

  it('reads a pid, and explains a missing or broken pid file', () => {
    const good = join(scratch, 'good.pid');
    writeFileSync(good, '4242\n');
    expect(readServerPid(good)).toBe(4242);
    expect(() => readServerPid(join(scratch, 'missing.pid'))).toThrow(/start-llm\.sh/);
    const bad = join(scratch, 'bad.pid');
    writeFileSync(bad, 'nope');
    expect(() => readServerPid(bad)).toThrow(/does not hold a pid/);
  });
});
