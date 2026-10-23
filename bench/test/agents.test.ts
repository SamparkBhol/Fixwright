import { describe, expect, it, vi } from 'vitest';
import { HUMAN_QUESTION_KINDS, runBench, toView, type HumanQuestion, type Scenario } from 'homefault';
import { loadIncidents } from 'homefault/incidents';
import { DEFAULT_ENDPOINT, DEFAULT_GENERATION } from '../llm/src/config.ts';
import type { VerdictCall } from '../llm/src/fetch-client.ts';
import type { DiagnosisInput } from '../llm/src/prompt.ts';
import { diagnoseScenario, fixwrightAgent, fixwrightScenario, toolFor, type FixwrightRecord } from '../src/agents/fixwright.ts';
import { baselineInput, llmAgent, requestKey, runBaseline, type CallCache, type LlmClients, type LlmRecord } from '../src/agents/llm.ts';
import { renderScenarioLog } from '../src/render.ts';

const incidents = loadIncidents();
const byCause = (cause: string): Scenario[] => incidents.filter((s) => s.ground_truth.cause_id === cause);

const stats = { wallMs: 1200, promptTokens: 900, completionTokens: 80, timings: null };
const ok = (cause_id: string, confidence: number): VerdictCall => ({
  ok: true,
  verdict: { cause_id, confidence, explanation: 'mock' },
  text: JSON.stringify({ cause_id, confidence, explanation: 'mock' }),
  reasoning: null,
  stats,
});
const fail = (kind: 'max_tokens' | 'invalid_output' | 'server_error' | 'request_failed'): VerdictCall => ({ ok: false, kind, error: `mock ${kind}`, text: null, reasoning: null, stats });

/** A mocked model: answers from a function of the input; records every call. */
function mockClients(answer: (input: DiagnosisInput) => VerdictCall, fetchAnswer?: () => VerdictCall) {
  const strands = vi.fn<LlmClients['strands']>(async (_e, input) => answer(input));
  const fetch = vi.fn<LlmClients['fetch']>(async () => (fetchAnswer ? fetchAnswer() : ok('hub_down', 0.5)));
  return { strands, fetch };
}

describe('Fixwright agent on reconstructed incidents', () => {
  it('asks only homefault question kinds, never errors on a mapping, and counts what it did', async () => {
    const records = new Map<string, FixwrightRecord>();
    const asked: HumanQuestion[] = [];
    const agent = fixwrightAgent({ onRecord: (r) => records.set(r.scenario_id, r) });
    const spy = { name: agent.name, diagnose: (v: Parameters<typeof agent.diagnose>[0], ask: Parameters<typeof agent.diagnose>[1]) => agent.diagnose(v, async (q) => (asked.push(q), ask(q))) };
    const result = await runBench(spy, incidents, { humanReliability: 1, seed: 1 });
    expect(result.cases).toHaveLength(20);
    for (const q of asked) expect(HUMAN_QUESTION_KINDS).toContain(q.kind);
    for (const c of result.cases) {
      const r = records.get(c.scenario_id) as FixwrightRecord;
      expect(c.error).toBeUndefined();
      expect(r.error_code ?? '').not.toMatch(/^unmapped_question|^exception|^too_many_turns/);
      // homefault counts the observations it answered; the record also counts permission questions.
      expect(c.human_questions).toBe(r.exchanges.filter((e) => e.kind === 'observe').length);
      expect(r.questions).toBe(r.exchanges.length);
      expect(r.consent_questions).toBe(r.exchanges.filter((e) => e.kind === 'consent').length);
      expect(c.probes_used).toBe(r.probes_used);
      expect(c.disruptive_probes).toBe(r.disruptive_probes);
      expect(r.probes_used).toBe(r.probe_ids.filter((id) => !(HUMAN_QUESTION_KINDS as readonly string[]).includes(id)).length);
    }
    // At least one incident needs the person (a flash or a wall switch) and at least one does not.
    expect(asked.length).toBeGreaterThan(0);
    expect(result.cases.some((c) => c.human_questions === 0)).toBe(true);
  });

  it('passes the question text and the device to the person, and the answer changes the verdict', async () => {
    const scenario = byCause('stale_duplicate').find((s) => s.human_truth.confirm_flash !== undefined) as Scenario;
    expect(scenario).toBeDefined();
    const view = toView(scenario);
    const seen: HumanQuestion[] = [];
    const yes = await diagnoseScenario(view, async (q) => (seen.push(q), 'yes'));
    const no = await diagnoseScenario(view, async () => 'no');
    expect(seen[0]?.kind).toBe('confirm_flash');
    expect(seen[0]?.text).toMatch(/flash/i);
    expect(seen[0]?.entity_id).toMatch(/\./);
    expect(yes.exchanges[0]).toMatchObject({ probe_id: 'confirm_flash', kind: 'observe', answer: 'yes' });
    expect(yes.disruptive_probes).toBeGreaterThanOrEqual(1);
    expect(yes.verdict?.cause_id).toBe('stale_duplicate');
    expect(no.verdict?.cause_id === 'stale_duplicate' && no.verdict.level === 'confirmed').toBe(false);
  });

  it('routes a question about something the home did to explain_event, like the live product', async () => {
    const scenario = byCause('power_on_default_on').find((s) => toolFor(s.symptom.text) === 'explain_event') as Scenario;
    expect(scenario).toBeDefined();
    const ask = vi.fn(async () => 'yes' as const);
    const r = await fixwrightScenario(toView(scenario), ask);
    expect(r.tool).toBe('explain_event');
    expect(r.explain_cause).toBe('power_restore');
    expect(r.verdict?.cause_id).toBe('power_on_default_on');
    expect(r.probes_used + r.questions).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    const forced = await fixwrightScenario(toView(scenario), ask, 1, 'diagnose');
    expect(forced.tool).toBe('diagnose');
  });

  it('is deterministic: the same scenario and answers give the same record', async () => {
    const view = toView(incidents[0] as Scenario);
    const a = await fixwrightScenario(view, async () => 'yes');
    const b = await fixwrightScenario(view, async () => 'yes');
    expect(a).toEqual(b);
  });
});

describe('LLM baselines with a mocked model', () => {
  const view = toView(incidents[0] as Scenario);
  const base = { endpoint: DEFAULT_ENDPOINT, gen: DEFAULT_GENERATION } as const;

  it('B1 sends the rendered logs and the symptom once through Strands; confidence >= 0.9 is confirmed', async () => {
    const m = mockClients(() => ok('stale_duplicate', 0.9));
    const r = await runBaseline(view, { ...base, variant: 'b1', clients: m });
    expect(m.strands).toHaveBeenCalledTimes(1);
    expect(m.fetch).not.toHaveBeenCalled();
    const input = m.strands.mock.calls[0]?.[1] as DiagnosisInput;
    expect(input).toEqual({ symptom: view.symptom.text, log: renderScenarioLog(view) });
    expect(r).toMatchObject({ path: 'strands', outcome: 'answer', scored: { cause_id: 'stale_duplicate', level: 'confirmed', confidence: 0.9 }, human_answers: 0 });
    expect(r.prompt_sha256).toBe(requestKey(input, base.endpoint, base.gen, 'json_schema').sha);
    const below = await runBaseline(view, { ...base, variant: 'b1', clients: mockClients(() => ok('stale_duplicate', 0.89)) });
    expect(below.scored.level).toBe('likely');
    const unknown = await runBaseline(view, { ...base, variant: 'b1', clients: mockClients(() => ok('unknown', 0.3)) });
    expect(unknown.scored).toMatchObject({ cause_id: 'unknown', level: 'cant_tell' });
  });

  it('an invalid answer or the token cap is can\'t tell and counted as invalid; the fallback never gets a second try', async () => {
    for (const kind of ['invalid_output', 'max_tokens'] as const) {
      const m = mockClients(() => fail(kind));
      const r = await runBaseline(view, { ...base, variant: 'b1', clients: m });
      expect(m.fetch).not.toHaveBeenCalled();
      expect(r).toMatchObject({ path: 'strands', outcome: kind, scored: { level: 'cant_tell', cause_id: 'invalid_output' } });
    }
  });

  it('falls back to fetch only when Strands gets no answer, and records which client answered', async () => {
    const m = mockClients(() => fail('request_failed'), () => ok('hub_down', 0.95));
    const r = await runBaseline(view, { ...base, variant: 'b1', clients: m });
    expect(r.path).toBe('fetch_fallback');
    expect(r.attempts.map((a) => [a.client, a.ok, a.kind ?? null])).toEqual([
      ['strands', false, 'request_failed'],
      ['fetch', true, null],
    ]);
    expect(r.scored).toMatchObject({ cause_id: 'hub_down', level: 'confirmed' });
  });

  it('retries a fully failed call once, then reports an infrastructure failure', async () => {
    const m = mockClients(() => fail('server_error'), () => fail('request_failed'));
    const sleep = vi.fn(async () => {});
    const r = await runBaseline(view, { ...base, variant: 'b1', clients: m, sleep, retryDelayMs: 5 });
    expect(sleep).toHaveBeenCalledWith(5);
    expect(m.strands).toHaveBeenCalledTimes(2);
    expect(m.fetch).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ path: 'failed', outcome: 'infra_error', scored: { cause_id: 'infra_error', level: 'cant_tell' } });
  });

  it('B2 adds the answers Fixwright got; with none, it reuses the identical B1 call', async () => {
    const cache: CallCache = new Map();
    const m = mockClients((input) => (input.humanAnswers ? ok('stale_duplicate', 0.95) : ok('name_collision', 0.6)));
    const qa = [{ question: "I'll flash the hallway lamp twice. Did it blink?", answer: 'yes' }];
    const b1 = await runBaseline(view, { ...base, variant: 'b1', clients: m, cache });
    const b2 = await runBaseline(view, { ...base, variant: 'b2', clients: m, cache, answersFor: () => qa });
    expect((m.strands.mock.calls[1]?.[1] as DiagnosisInput).humanAnswers).toEqual(qa);
    expect(b2).toMatchObject({ variant: 'b2', path: 'strands', human_answers: 1, scored: { cause_id: 'stale_duplicate', level: 'confirmed' } });
    expect(b2.prompt_sha256).not.toBe(b1.prompt_sha256);
    const b2none: LlmRecord = await runBaseline(view, { ...base, variant: 'b2', clients: m, cache, answersFor: () => [] });
    expect(m.strands).toHaveBeenCalledTimes(2);
    expect(b2none).toMatchObject({ variant: 'b2', path: 'reused', reused_from: 'b1', prompt_sha256: b1.prompt_sha256, scored: b1.scored });
  });

  it('as a bench agent: never asks the person, and B2 refuses to run without Fixwright\'s answers', async () => {
    expect(() => llmAgent({ ...base, variant: 'b2' })).toThrow(/answersFor/);
    const ask = vi.fn(async () => 'yes' as const);
    const agent = llmAgent({ ...base, variant: 'b1', clients: mockClients(() => ok('vendor_cloud_outage', 0.92)) });
    const v = await agent.diagnose(view, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(v).toMatchObject({ cause_id: 'vendor_cloud_outage', level: 'confirmed', probes_used: 0, disruptive_probes: 0 });
  });
});

describe('what the baselines read', () => {
  it('is deterministic and never leaks the title, source, ground truth or human truth', () => {
    for (const s of incidents) {
      const text = renderScenarioLog(toView(s));
      expect(renderScenarioLog(toView(s))).toBe(text);
      expect(text).not.toContain(s.title);
      expect(text).not.toContain(s.source.url);
      expect(text).not.toContain(s.ground_truth.cause_id);
      expect(baselineInput(toView(s)).log).toBe(text);
    }
  });
});
