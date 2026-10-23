import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { VerdictCall } from '../llm/src/fetch-client.ts';
import type { DiagnosisInput } from '../llm/src/prompt.ts';
import { DEFAULT_GENERATION } from '../llm/src/config.ts';
import type { LlmClients } from '../src/agents/llm.ts';
import { parseCli, runCli, type CliDeps } from '../src/cli.ts';
import { hometruthText, type HometruthInput } from '../src/hometruth.ts';
import { computeMetrics } from '../src/metrics.ts';
import type { ServerInfo } from '../src/meta.ts';
import type { Report } from '../src/report.ts';

const SERVER: ServerInfo = {
  reachable: true,
  build_info: 'b0-mock',
  model_file: 'mock.gguf',
  model_ftype: 'MOCK',
  total_slots: 1,
  n_ctx: 16384,
  args: ['llama-server', '--threads', '8', '--threads-batch', '8'],
};

function model(): LlmClients {
  const answer = async (_e: unknown, input: DiagnosisInput): Promise<VerdictCall> => ({
    ok: true,
    verdict: { cause_id: input.humanAnswers ? 'hub_down' : 'stale_duplicate', confidence: 0.95, explanation: 'fake' },
    text: '{}',
    reasoning: null,
    stats: { wallMs: 1000, promptTokens: 500, completionTokens: 40, timings: null },
  });
  return { strands: answer, fetch: answer } as unknown as LlmClients;
}

function deps(): CliDeps {
  let t = 0;
  return {
    env: { LLM_BASE_URL: 'http://127.0.0.1:8779/v1' },
    gen: DEFAULT_GENERATION,
    clients: model(),
    serverInfo: async () => SERVER,
    serverCounters: async () => ({ prompt_tokens: (t += 1000), prompt_seconds: t / 70, prompt_tokens_cached: 0, predicted_tokens: t / 10, predicted_seconds: t / 200 }),
    machineInfo: () => ({ cpu: 'test cpu', vcpus: 2, total_mem_gib: 4, node: 'v22', load_average: [1, 1, 1] }),
    now: () => new Date('2026-10-17T12:00:00.000Z'),
    timer: () => (t += 5),
    log: () => {},
  };
}

// Each run writes into a scratch directory next to the tests, removed afterwards; only the in memory
// reports are used.
const OUT = join(import.meta.dirname, '..', '.test-out-ht');
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

async function run(argv: string[]): Promise<Report> {
  const name = `ht-${argv.join('').replace(/[^A-Za-z0-9]+/g, '')}.json`;
  return (await runCli(parseCli([...argv, '--out', name], OUT), deps())).report;
}

async function input(): Promise<HometruthInput> {
  const fw = await run(['--set', 'incidents']);
  return {
    writtenAt: '2026-10-17T20:00:00.000Z',
    final: { dev: fw, heldout: fw, incidents: fw, all: fw },
    start: { incidents: structuredClone(fw) },
    diagnoseOnly: await run(['--set', 'incidents', '--fixwright-routing', 'diagnose']),
    heldout: await run(['--agents', 'b1,b2', '--set', 'incidents', '--n', '10', '--stratified', '--seed', '1']),
    incidents: await run(['--agents', 'b1,b2', '--set', 'incidents']),
  };
}

describe('hometruthText', () => {
  it('reports the measured metrics with intervals for all three agents, settings and the verdict', async () => {
    const i = await input();
    const text = hometruthText(i);
    const fw = computeMetrics(i.incidents.cases.filter((r) => r.agent === 'fixwright'));
    const b1 = computeMetrics(i.incidents.cases.filter((r) => r.agent === 'b1'));
    expect(text).toContain(`top1                 ${fw.top1.value?.toFixed(3)} (${fw.top1.k} of 20)`);
    expect(text).toContain(`top1                 ${b1.top1.value?.toFixed(3)} (${b1.top1.k} of 20)`);
    expect(text).toMatch(/Both together \(30 scenarios\)/);
    expect(text).toContain('threads 8, batch threads 8');
    expect(text).toContain('cache_prompt false');
    expect(text).toContain('wrong 10% of the time');
    // 10 paired held-out scenarios: below the 30 the rule needs.
    expect(text).toMatch(/Held-out sample of 10 \(the verdict\): not conclusive/);
    expect(text).toMatch(/Both together \(30\): (FIRES|does not fire)/);
    expect(text).toContain('incidents: 0 of 20 Fixwright answers differ');
    for (const section of ['WHAT RAN', 'MODEL AND SETTINGS', 'KILL SWITCH', 'HONEST CAVEATS', 'WHAT THESE NUMBERS DO NOT SHOW']) expect(text).toContain(section);
    expect(text).not.toMatch(/[–—]|seamless|unlock|journey|delve|robust|leverage/i);
  });

  it('counts Fixwright answers that changed between the start and the final run', async () => {
    const i = await input();
    const start = i.start.incidents as Report;
    const row = start.cases.find((r) => r.agent === 'fixwright');
    if (!row) throw new Error('no fixwright row');
    row.got = row.got === 'hub_down' ? 'stale_duplicate' : 'hub_down';
    expect(hometruthText(i)).toContain('incidents: 1 of 20 Fixwright answers differ');
  });

  it('withholds the kill switch verdict when baseline calls got no answer', async () => {
    const i = await input();
    expect(hometruthText(i)).toContain('Unanswered calls. None');
    const b1 = i.heldout.cases.find((r) => r.agent === 'b1');
    if (!b1) throw new Error('no b1 row');
    Object.assign(b1, { infra_error: true, got: 'unknown', correct: false, abstained: true });
    const text = hometruthText(i);
    expect(text).toMatch(/Held-out sample of 10 \(the verdict\): WITHHELD: 1 baseline calls got no answer/);
    expect(text).toContain('Verdict: withheld. 1 B1 or B2 calls on the deciding set');
    expect(text).toContain('Unanswered calls. 1 B1 or B2 calls (held-out 1, incidents 0)');
  });

  it('derives the caveat numbers from the reports', async () => {
    const text = hometruthText(await input());
    // The test feeds the 20 incidents in place of every set, so the derived numbers follow them.
    expect(text).toContain('The 40 dev and held-out scenarios');
    expect(text).toContain('The 20 incidents are hand reconstructions');
    expect(text).toContain('Below 30 paired scenarios');
    expect(text).not.toContain('it does not fire only on large gaps');
  });
});
