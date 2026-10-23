// Offline tests of both clients: a fake fetch plays llama-server, so the full Strands -> OpenAI SDK ->
// HTTP path and the plain fetch path are exercised without a model.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENDPOINT, DEFAULT_GENERATION, endpointFromEnv, serverRoot } from '../src/config.ts';
import { buildChatRequest, fetchVerdict, MAX_TOKENS_ERROR, type FetchLike } from '../src/fetch-client.ts';
import { HALLWAY_LAMP_CASE } from '../src/fixtures.ts';
import { diagnosisMessages } from '../src/prompt.ts';
import { createLocalModel, strandsVerdict } from '../src/strands-client.ts';

const verdict = { cause_id: 'stale_duplicate', confidence: 0.93, explanation: 'The name points at the restored, offline copy.' };

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (body: Record<string, unknown>) => Response): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    return respond(body);
  };
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A Chat Completions SSE stream the way llama-server sends it. */
function sse(chunks: readonly Record<string, unknown>[]): Response {
  const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'gpt-oss-20b' };
  const text = chunks.map((c) => `data: ${JSON.stringify({ ...base, ...c })}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const usageChunk = { choices: [], usage: { prompt_tokens: 410, completion_tokens: 57, total_tokens: 467 } };

describe('config', () => {
  it('defaults to the module port and strips trailing slashes', () => {
    expect(endpointFromEnv({})).toEqual(DEFAULT_ENDPOINT);
    expect(endpointFromEnv({ LLM_BASE_URL: 'http://127.0.0.1:8772/v1/' }).baseUrl).toBe('http://127.0.0.1:8772/v1');
    expect(serverRoot(DEFAULT_ENDPOINT)).toBe('http://127.0.0.1:8771');
  });
});

describe('fetch client', () => {
  it('sends grammar-constrained JSON with low reasoning effort', () => {
    const body = buildChatRequest(DEFAULT_ENDPOINT, diagnosisMessages(HALLWAY_LAMP_CASE), DEFAULT_GENERATION);
    expect(body).toMatchObject({
      model: 'gpt-oss-20b',
      stream: false,
      temperature: 0,
      seed: 42,
      // Off by default: prompt reuse changed the greedy answer in live runs (results/repro_check.json).
      cache_prompt: false,
      chat_template_kwargs: { reasoning_effort: 'low' },
      response_format: { type: 'json_schema', json_schema: { name: 'diagnosis', strict: true } },
    });
  });

  it('parses a llama-server response and keeps usage, timings and reasoning apart', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, {
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(verdict), reasoning_content: 'Two copies share a name.' } }],
        usage: { prompt_tokens: 410, completion_tokens: 57 },
        timings: { prompt_n: 410, prompt_ms: 3000, prompt_per_second: 136.7, predicted_n: 57, predicted_ms: 2500, predicted_per_second: 22.8 },
      }),
    );
    let t = 0;
    const r = await fetchVerdict(DEFAULT_ENDPOINT, diagnosisMessages(HALLWAY_LAMP_CASE), DEFAULT_GENERATION, { fetchImpl, nowMs: () => (t += 100) });
    expect(calls[0]?.url).toBe('http://127.0.0.1:8771/v1/chat/completions');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict).toEqual(verdict);
    expect(r.reasoning).toBe('Two copies share a name.');
    expect(r.stats).toMatchObject({ wallMs: 100, promptTokens: 410, completionTokens: 57 });
    expect(r.stats.timings?.predicted_per_second).toBe(22.8);
  });

  it('reports HTTP errors, truncation and schema failures as typed failures without throwing', async () => {
    const http = await fetchVerdict(DEFAULT_ENDPOINT, [], DEFAULT_GENERATION, { fetchImpl: fakeFetch(() => json(503, { error: { message: 'Loading model' } })).fetchImpl });
    expect(http).toMatchObject({ ok: false, kind: 'server_error', error: 'HTTP 503: Loading model' });

    const cut = await fetchVerdict(DEFAULT_ENDPOINT, [], DEFAULT_GENERATION, {
      fetchImpl: fakeFetch(() =>
        json(200, { choices: [{ finish_reason: 'length', message: { content: '{"cause_id": "hub' } }], usage: { prompt_tokens: 410, completion_tokens: 16 } }),
      ).fetchImpl,
    });
    expect(cut).toMatchObject({ ok: false, kind: 'max_tokens', error: MAX_TOKENS_ERROR, text: '{"cause_id": "hub' });
    expect(cut.stats).toMatchObject({ promptTokens: 410, completionTokens: 16 });

    const bad = await fetchVerdict(DEFAULT_ENDPOINT, [], DEFAULT_GENERATION, {
      fetchImpl: fakeFetch(() => json(200, { choices: [{ finish_reason: 'stop', message: { content: '{"cause_id":"gremlins","confidence":1,"explanation":"x"}' } }] })).fetchImpl,
    });
    expect(bad).toMatchObject({ ok: false, kind: 'invalid_output' });

    const empty = await fetchVerdict(DEFAULT_ENDPOINT, [], DEFAULT_GENERATION, { fetchImpl: fakeFetch(() => json(200, { choices: [] })).fetchImpl });
    expect(empty).toMatchObject({ ok: false, kind: 'server_error' });

    const down = await fetchVerdict(DEFAULT_ENDPOINT, [], DEFAULT_GENERATION, {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(down).toMatchObject({ ok: false, kind: 'request_failed', error: 'request failed: fetch failed' });
  });
});

describe('Strands client', () => {
  it('configures the OpenAI provider for llama-server', () => {
    const model = createLocalModel(DEFAULT_ENDPOINT, DEFAULT_GENERATION, 'json_schema');
    expect(model.api).toBe('chat');
    const cfg = model.getConfig();
    expect(cfg).toMatchObject({ modelId: 'gpt-oss-20b', temperature: 0, maxTokens: 1024 });
    expect(cfg.params).toMatchObject({ seed: 42, chat_template_kwargs: { reasoning_effort: 'low' }, response_format: { type: 'json_schema' } });
    expect(createLocalModel(DEFAULT_ENDPOINT, DEFAULT_GENERATION, 'structured_output').getConfig().params?.response_format).toBeUndefined();
  });

  it('json_schema mode: streams text through the agent and parses it', async () => {
    const text = JSON.stringify(verdict);
    const { fetchImpl, calls } = fakeFetch(() =>
      sse([
        { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: text.slice(0, 20) }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: text.slice(20) }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        usageChunk,
      ]),
    );
    const r = await strandsVerdict(DEFAULT_ENDPOINT, HALLWAY_LAMP_CASE, DEFAULT_GENERATION, 'json_schema', { fetchImpl });
    expect(r).toMatchObject({ ok: true, verdict });
    expect(r.stats).toMatchObject({ promptTokens: 410, completionTokens: 57 });
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(sent.url).toBe('http://127.0.0.1:8771/v1/chat/completions');
    expect(sent.body).toMatchObject({ model: 'gpt-oss-20b', stream: true, temperature: 0, max_completion_tokens: 1024, seed: 42, cache_prompt: false });
    expect(sent.body.response_format).toMatchObject({ type: 'json_schema' });
    const messages = sent.body.messages as { role: string; content: unknown }[];
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(JSON.stringify(messages[1])).toContain('Hallway Lamp');
  });

  it('structured_output mode: validates the forced tool call', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      sse([
        { choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'strands_structured_output', arguments: JSON.stringify(verdict) } }] },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        usageChunk,
      ]),
    );
    const r = await strandsVerdict(DEFAULT_ENDPOINT, HALLWAY_LAMP_CASE, DEFAULT_GENERATION, 'structured_output', { fetchImpl });
    expect(r).toMatchObject({ ok: true, verdict });
    const tools = calls[0]?.body.tools as { function: { name: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual(['strands_structured_output']);
  });

  // Strands throws MaxTokensError on finish_reason 'length' instead of returning a result; the client
  // must still report it exactly like the fetch client does, with the partial text and token usage.
  it.each(['json_schema', 'structured_output'] as const)('%s mode: a truncated answer is a max_tokens failure, like fetch', async (mode) => {
    const { fetchImpl } = fakeFetch(() =>
      sse([
        { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: '{"cause_id": "stale_dup' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
        { choices: [], usage: { prompt_tokens: 410, completion_tokens: 16, total_tokens: 426 } },
      ]),
    );
    const r = await strandsVerdict(DEFAULT_ENDPOINT, HALLWAY_LAMP_CASE, { ...DEFAULT_GENERATION, maxTokens: 16 }, mode, { fetchImpl });
    expect(r).toMatchObject({ ok: false, kind: 'max_tokens', error: MAX_TOKENS_ERROR, text: '{"cause_id": "stale_dup' });
    expect(r.stats).toMatchObject({ promptTokens: 410, completionTokens: 16 });
  });

  it('json_schema mode: an answer that fails the schema is invalid_output', async () => {
    const { fetchImpl } = fakeFetch(() =>
      sse([
        { choices: [{ index: 0, delta: { role: 'assistant', content: '{"cause_id":"gremlins","confidence":1,"explanation":"x"}' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        usageChunk,
      ]),
    );
    const r = await strandsVerdict(DEFAULT_ENDPOINT, HALLWAY_LAMP_CASE, DEFAULT_GENERATION, 'json_schema', { fetchImpl });
    expect(r).toMatchObject({ ok: false, kind: 'invalid_output' });
    if (!r.ok) expect(r.error).toMatch(/cause_id/);
  });

  it('reports an HTTP error as server_error and a dead server as request_failed', async () => {
    const http = await strandsVerdict(DEFAULT_ENDPOINT, HALLWAY_LAMP_CASE, DEFAULT_GENERATION, 'json_schema', {
      fetchImpl: fakeFetch(() => json(500, { error: { message: 'boom' } })).fetchImpl,
    });
    // Same wording as the fetch client for the same server answer.
    expect(http).toMatchObject({ ok: false, kind: 'server_error', error: 'HTTP 500: boom' });

    const down = await strandsVerdict(DEFAULT_ENDPOINT, HALLWAY_LAMP_CASE, DEFAULT_GENERATION, 'json_schema', {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(down).toMatchObject({ ok: false, kind: 'request_failed' });
    if (!down.ok) expect(down.error).toMatch(/^strands invoke failed: /);
  });
});
