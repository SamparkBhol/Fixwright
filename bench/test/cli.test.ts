import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GENERATION } from '../llm/src/config.ts';
import type { VerdictCall } from '../llm/src/fetch-client.ts';
import type { DiagnosisInput } from '../llm/src/prompt.ts';
import type { LlmClients } from '../src/agents/llm.ts';
import { CHECKPOINT_MISMATCH, fingerprintOf, openCheckpoint, readCheckpoint, stableJson } from '../src/checkpoint.ts';
import { BENCH_ROOT, commandArgs, parseCli, runCli, settingsProblem, type CliDeps } from '../src/cli.ts';
import type { CaseRow } from '../src/metrics.ts';
import { checkpointPathFor, summaryPathFor, type Report } from '../src/report.ts';
import type { ServerCounters, ServerInfo } from '../src/meta.ts';

// Test output stays inside the workspace and is removed afterwards.
const OUT = join(BENCH_ROOT, '.test-out');
beforeAll(() => mkdirSync(OUT, { recursive: true }));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

const SERVER: ServerInfo = { reachable: true, build_info: 'b0-mock', model_file: 'mock.gguf', total_slots: 1, n_ctx: 16384 };

/** A fake model that answers from the symptom and the person's answers, and counts its calls. */
function fakeModel() {
  const answer = (input: DiagnosisInput): VerdictCall => {
    const cause = /plug|light/i.test(input.symptom) ? 'power_on_default_on' : 'stale_duplicate';
    const confidence = input.humanAnswers ? 0.95 : 0.7;
    return { ok: true, verdict: { cause_id: cause, confidence, explanation: 'fake' }, text: `{"cause_id":"${cause}"}`, reasoning: null, stats: { wallMs: 100, promptTokens: 500, completionTokens: 40, timings: null } };
  };
  const strands = vi.fn<LlmClients['strands']>(async (_e, input) => answer(input));
  const fetch = vi.fn<LlmClients['fetch']>(async () => {
    throw new Error('fetch fallback must not run');
  });
  return { strands, fetch };
}

function deps(over: Partial<CliDeps> = {}): CliDeps {
  let t = 0;
  let counters = 0;
  return {
    env: { LLM_BASE_URL: 'http://127.0.0.1:8779/v1' },
    gen: DEFAULT_GENERATION,
    clients: fakeModel(),
    serverInfo: async () => SERVER,
    serverCounters: async (): Promise<ServerCounters> => {
      counters += 1000;
      return { prompt_tokens: counters, prompt_seconds: counters / 70, prompt_tokens_cached: 0, predicted_tokens: counters / 10, predicted_seconds: counters / 200 };
    },
    machineInfo: () => ({ cpu: 'test cpu', vcpus: 2, total_mem_gib: 4, node: 'v22', load_average: [0, 0, 0] }),
    now: () => new Date('2026-10-17T12:00:00.000Z'),
    timer: () => (t += 5),
    log: () => {},
    ...over,
  };
}

const args = (out: string, extra: string[] = []) => ['--agents', 'b1,b2', '--set', 'incidents', '--n', '6', '--stratified', '--seed', '3', '--out', out, ...extra];
const brief = (rows: readonly CaseRow[]) => rows.map((r) => `${r.agent}|${r.scenario_id}|${r.got}|${r.level}|${r.confidence}`);

describe('parseCli', () => {
  it('reads every flag and builds the output paths', () => {
    const o = parseCli(['--agents', 'b2,fixwright', '--set', 'dev', '--n', '20', '--stratified', '--seed', '9', '--human-reliability', '0.8', '--out', 'x1']);
    expect(o).toMatchObject({ agents: ['fixwright', 'b2'], set: 'dev', n: 20, stratified: true, seed: 9, humanReliability: 0.8, name: 'x1', fixwrightRouting: 'router', mode: 'json_schema', reuse: true });
    expect(o.out).toBe(join(BENCH_ROOT, 'results', 'x1.json'));
    expect(parseCli([]).name).toBe('heldout-fixwright');
    expect(parseCli(['--out', 'sub/run.json'], '/w').out).toBe('/w/sub/run.json');
    expect(commandArgs(o)).toEqual(['--agents', 'fixwright,b2', '--set', 'dev', '--n', '20', '--stratified', '--seed', '9', '--human-reliability', '0.8', '--human-seed', '1', '--out', 'x1']);
  });

  it('rejects bad input with a plain message', () => {
    expect(() => parseCli(['--agents', 'gpt'])).toThrow(/Unknown agent/);
    expect(() => parseCli(['--set', 'test'])).toThrow(/Unknown set/);
    expect(() => parseCli(['--n', '0'])).toThrow(/--n/);
    expect(() => parseCli(['--stratified'])).toThrow(/needs --n/);
    expect(() => parseCli(['--ids', 'a', '--n', '2'])).toThrow(/not both/);
    expect(() => parseCli(['--human-reliability', '0.2'])).toThrow(/between/);
    expect(() => parseCli(['--resume', '--fresh'])).toThrow(/not both/);
    expect(() => parseCli(['--out', '../evil'])).toThrow(/may use/);
    expect(() => parseCli(['--bogus'])).toThrow();
  });
});

describe('settingsProblem', () => {
  it('refuses the settings that made answers depend on call order', () => {
    expect(settingsProblem(SERVER, DEFAULT_GENERATION)).toBeNull();
    expect(settingsProblem({ reachable: false, error: 'ECONNREFUSED' }, DEFAULT_GENERATION)).toMatch(/start-llm/);
    expect(settingsProblem({ ...SERVER, total_slots: 2 }, DEFAULT_GENERATION)).toMatch(/exactly one/);
    expect(settingsProblem(SERVER, { ...DEFAULT_GENERATION, cachePrompt: true })).toMatch(/cache_prompt/);
    expect(settingsProblem(SERVER, { ...DEFAULT_GENERATION, temperature: 0.7 })).toMatch(/temperature/);
  });
});

describe('checkpoint', () => {
  it('hashes configurations by value, not key order', () => {
    expect(stableJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(fingerprintOf({ a: 1, b: 2 })).toBe(fingerprintOf({ b: 2, a: 1 }));
  });

  it('skips a line cut off by a crash, refuses another run\'s file and a corrupted one', () => {
    const path = join(OUT, 'unit.partial.jsonl');
    const row = { agent: 'b1', scenario_id: 's1' } as CaseRow;
    const w = openCheckpoint(path, 'f1', { x: 1 });
    w.append(row);
    writeFileSync(path, readFileSync(path, 'utf8') + '{"type":"row","row":{"agent":"b');
    expect(readCheckpoint(path, 'f1')).toEqual([row]);
    expect(() => readCheckpoint(path, 'f2')).toThrow(expect.objectContaining({ code: CHECKPOINT_MISMATCH }));
    writeFileSync(path, readFileSync(path, 'utf8').replace('"row":{', '"row":{{') + '\n{"type":"row","row":{}}\n');
    expect(() => readCheckpoint(path, 'f1')).toThrow(/not valid JSON/);
    w.remove();
    expect(existsSync(path)).toBe(false);
    expect(readCheckpoint(path, 'f1')).toEqual([]);
  });
});

describe('runCli end to end with a fake model', () => {
  it('writes the result JSON and the plain text summary with sizes, model, settings, date and kill switch', async () => {
    const d = deps();
    const { report, files } = await runCli(parseCli(args('e2e.json'), OUT), { ...d });
    expect(files.json).toBe(join(OUT, 'e2e.json'));
    const json = JSON.parse(readFileSync(files.json, 'utf8')) as Report;
    const text = readFileSync(files.summary, 'utf8');
    rmSync(files.json);
    rmSync(files.summary);
    expect(existsSync(checkpointPathFor(files.json))).toBe(false);
    expect(json.format).toBe('hometruth.results/1');
    expect(json.scenarios).toMatchObject({ set_size: 20, run: 6 });
    expect(json.cases).toHaveLength(18);
    expect(Object.keys(json.metrics)).toEqual(['fixwright', 'b1', 'b2']);
    expect(json.llm?.generation).toEqual(DEFAULT_GENERATION);
    expect(json.llm?.server.total_slots).toBe(1);
    expect(json.llm?.counters.b1?.prompt_tokens_cached).toBe(0);
    expect(json.kill_switch.evaluated).toBe(true);
    expect(json.kill_switch.comparisons.map((c) => c.n)).toEqual([6, 6]);
    const b1 = json.metrics.b1?.all;
    expect(b1?.top1.ci95).not.toBeNull();
    expect(b1?.llm?.paths.strands).toBe(6);
    // B2 calls the model only where Fixwright asked the person something.
    const asked = json.cases.filter((c) => c.agent === 'fixwright' && (c.fixwright?.exchanges.some((e) => e.kind === 'observe') ?? false)).length;
    expect(json.metrics.b2?.all.llm?.paths.reused).toBe(6 - asked);
    for (const needle of ['Set: incidents, a stratified sample of 6 out of 20 (seed 3)', 'Model: gpt-oss-20b (mock.gguf', 'temperature 0, seed 42', 'cache_prompt false', 'one call at a time', 'Date: 2026-10-17T12:00:00.000Z', 'Kill switch (rule set before the run)', 'Not conclusive: only 6 paired scenarios', '95% CI', 'p50', 'p95', 'invalid outputs']) {
      expect(text).toContain(needle);
    }
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(report.config.resumed_cases).toBe(0);
  });

  it('resumes a crashed run: only the missing cases reach the model, and the result equals an uninterrupted run', async () => {
    const full = await runCli(parseCli(args('full.json'), OUT), deps());

    const crashing = fakeModel();
    let seen = 0;
    const crash = deps({
      clients: crashing,
      onRow: (row) => {
        if (row.agent === 'b1' && ++seen === 4) throw new Error('simulated crash');
      },
    });
    const opts = parseCli(args('crash.json'), OUT);
    await expect(runCli(opts, crash)).rejects.toThrow('simulated crash');
    const checkpoint = checkpointPathFor(opts.out);
    expect(existsSync(checkpoint)).toBe(true);
    expect(existsSync(opts.out)).toBe(false);

    // Without --resume the checkpoint is not silently thrown away.
    await expect(runCli(opts, deps())).rejects.toThrow(/--resume/);
    // A different configuration cannot pick it up.
    await expect(runCli(parseCli(args('crash.json', ['--human-seed', '2', '--resume']), OUT), deps())).rejects.toThrow(/different settings/);

    const resumedModel = fakeModel();
    const resumed = await runCli(parseCli(args('crash.json', ['--resume']), OUT), deps({ clients: resumedModel }));
    expect(resumed.report.config.resumed_cases).toBe(4);
    const b1Calls = resumedModel.strands.mock.calls.filter((c) => !(c[1] as DiagnosisInput).humanAnswers).length;
    expect(b1Calls).toBe(2);
    expect(brief(resumed.report.cases)).toEqual(brief(full.report.cases));
    expect(resumed.report.metrics.b2?.all.top1).toEqual(full.report.metrics.b2?.all.top1);
    expect(existsSync(checkpoint)).toBe(false);
    expect(readFileSync(summaryPathFor(opts.out), 'utf8')).toContain('Resumed: 4 baseline cases');
  });

  it('keeps the checkpoint when a case got no answer from the server, and a resume retries only that case', async () => {
    const down = fakeModel();
    let calls = 0;
    const answerOf = down.strands.getMockImplementation();
    down.strands.mockImplementation(async (e, input, ...rest) => {
      calls++;
      if (calls === 1) return { ok: false, kind: 'server_error', error: 'mock server_error', text: null, reasoning: null, stats: { wallMs: 1, promptTokens: null, completionTokens: null, timings: null } };
      return (answerOf as NonNullable<typeof answerOf>)(e, input, ...rest);
    });
    down.fetch.mockImplementation(async () => ({ ok: false, kind: 'request_failed', error: 'mock request_failed', text: null, reasoning: null, stats: { wallMs: 1, promptTokens: null, completionTokens: null, timings: null } }));
    const opts = parseCli(args('infra.json'), OUT);
    const first = await runCli(opts, deps({ clients: down, infraRetries: 0, retryDelayMs: 0 }));
    expect(first.report.metrics.b1?.all.infra_errors).toBe(1);
    expect(existsSync(checkpointPathFor(opts.out))).toBe(true);

    const retry = fakeModel();
    const second = await runCli(parseCli(args('infra.json', ['--resume']), OUT), deps({ clients: retry }));
    expect(second.report.metrics.b1?.all.infra_errors).toBe(0);
    expect(retry.strands.mock.calls.filter((c) => !(c[1] as DiagnosisInput).humanAnswers)).toHaveLength(1);
    expect(existsSync(checkpointPathFor(opts.out))).toBe(false);
  });

  it('refuses to call a model on a server whose settings break reproducibility', async () => {
    const model = fakeModel();
    await expect(runCli(parseCli(args('slots.json'), OUT), deps({ clients: model, serverInfo: async () => ({ ...SERVER, total_slots: 4 }) }))).rejects.toThrow(/exactly one/);
    expect(model.strands).not.toHaveBeenCalled();
  });

  it('runs Fixwright alone without a server and without a checkpoint', async () => {
    const info = vi.fn(async () => SERVER);
    const { report } = await runCli(parseCli(['--set', 'incidents', '--out', 'fw.json'], OUT), deps({ serverInfo: info }));
    expect(info).not.toHaveBeenCalled();
    expect(report.llm).toBeNull();
    expect(report.kill_switch.evaluated).toBe(false);
    expect(report.metrics.fixwright?.all.n).toBe(20);
    expect(report.metrics.fixwright?.all.fixwright?.tools).toBeDefined();
  });
});
