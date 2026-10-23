// The start and stop scripts against a fake server, so no model is needed. The fake "llama-server" is a
// copy of bash: its /proc/<pid>/exe is then the fake binary, exactly what llm_pid_is_server checks.
// Ports 8778 and 8779 are in the LLM tools' range and no real server uses them.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endpointFromEnv } from '../src/config.ts';
import { pidFileFor } from '../src/proc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const scriptDir = resolve(here, '..');
const bashPath = ['/usr/bin/bash', '/bin/bash'].find((p) => existsSync(p));
const linux = existsSync('/proc/self/exe') && bashPath !== undefined;

const RUNNING_PORT = 8778;
const OTHER_PORT = 8779;

let scratch = '';
let env: NodeJS.ProcessEnv = {};
let fake: ChildProcess | undefined;

/**
 * Runs a script without blocking the event loop. The fake server is this process's child, and Node
 * reaps a dead child only from its event loop; under spawnSync it would linger as a zombie that
 * `kill -0` still reports alive. (A real server is detached by setsid and reaped by init.)
 */
function run(script: string, port: number): Promise<{ status: number | null; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn('bash', [join(scriptDir, script)], { env: { ...env, LLM_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.once('error', fail);
    child.once('close', (status) => done({ status, out }));
  });
}

/** The pid and log file paths llm-config.sh derives for a port (asked from the shell, not assumed). */
function shellPaths(port: number): { pidFile: string; logFile: string } {
  const r = spawnSync('bash', ['-c', `source ${join(scriptDir, 'llm-config.sh')} && printf '%s\\n%s\\n' "$LLM_PID_FILE" "$LLM_LOG_FILE"`], {
    env: { ...env, LLM_PORT: String(port) },
    encoding: 'utf8',
  });
  const [pidFile = '', logFile = ''] = r.stdout.trim().split('\n');
  return { pidFile, logFile };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!linux)('start-llm.sh and stop-llm.sh (fake server)', () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'llm-scripts-test-'));
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    copyFileSync(bashPath!, join(bin, 'llama-server'));
    chmodSync(join(bin, 'llama-server'), 0o755);
    writeFileSync(join(scratch, 'model.gguf'), '');
    env = { ...process.env, LLAMA_DIR: bin, LLM_MODEL_FILE: join(scratch, 'model.gguf'), LLM_RUN_DIR: join(scratch, 'run'), LLM_START_TIMEOUT_S: '10' };
    delete env.LLM_API_KEY;
    mkdirSync(join(scratch, 'run'));

    // A "server" on RUNNING_PORT: a builtin read keeps it alive with no child process to orphan.
    fake = spawn(join(bin, 'llama-server'), ['-c', 'read -t 120 || true', 'fake', '--port', String(RUNNING_PORT), '--fake'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    await new Promise<void>((ok, fail) => fake!.once('spawn', ok).once('error', fail));
    writeFileSync(shellPaths(RUNNING_PORT).pidFile, `${fake.pid}\n`);
  });

  afterAll(() => {
    if (fake?.pid !== undefined && alive(fake.pid)) fake.kill('SIGKILL');
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('derives one pid file and log per port, the same pid file the TypeScript side reads', () => {
    const other = shellPaths(OTHER_PORT);
    expect(other.pidFile).toBe(pidFileFor(endpointFromEnv({ LLM_PORT: String(OTHER_PORT) }), join(scratch, 'run')));
    expect(other.logFile).toBe(join(scratch, 'run', `llama-server-${OTHER_PORT}.log`));
    const running = shellPaths(RUNNING_PORT);
    expect(running.pidFile).not.toBe(other.pidFile);
    expect(running.logFile).not.toBe(other.logFile);
  });

  it('a failed start on another port leaves the running server and its pid file alone', { timeout: 30_000 }, async () => {
    const pid = fake!.pid!;
    const started = await run('start-llm.sh', OTHER_PORT);
    // The fake binary rejects llama-server's flags and exits, so this start must fail cleanly.
    expect(started.status, started.out).toBe(1);
    expect(started.out).toContain('server exited during startup');
    expect(existsSync(shellPaths(OTHER_PORT).pidFile)).toBe(false);
    // With a pid file shared across ports, this start deleted the running server's file (the old orphan bug).
    expect(readFileSync(shellPaths(RUNNING_PORT).pidFile, 'utf8').trim()).toBe(String(pid));
    expect(alive(pid)).toBe(true);

    const stopOther = await run('stop-llm.sh', OTHER_PORT);
    expect(stopOther.status).toBe(0);
    expect(stopOther.out).toContain('no pid file');
    expect(alive(pid)).toBe(true);
  });

  it('stop-llm.sh stops the server on its own port with SIGTERM and removes its pid file', { timeout: 30_000 }, async () => {
    const pid = fake!.pid!;
    const exited = new Promise<NodeJS.Signals | null>((ok) => fake!.once('exit', (_code, signal) => ok(signal)));
    const stopped = await run('stop-llm.sh', RUNNING_PORT);
    expect(stopped.status, stopped.out).toBe(0);
    expect(stopped.out).toContain(`stopped pid ${pid}`);
    expect(stopped.out).not.toContain('SIGKILL');
    expect(await exited).toBe('SIGTERM');
    expect(existsSync(shellPaths(RUNNING_PORT).pidFile)).toBe(false);
  });

  it('stop-llm.sh never signals a pid that is not our server', { timeout: 30_000 }, async () => {
    const { pidFile } = shellPaths(RUNNING_PORT);
    writeFileSync(pidFile, `${process.pid}\n`);
    const r = await run('stop-llm.sh', RUNNING_PORT);
    expect(r.status).toBe(0);
    expect(r.out).toContain('is not our llama-server');
    expect(alive(process.pid)).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });
});
