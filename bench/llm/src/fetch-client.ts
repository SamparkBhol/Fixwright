import type { GenerationOptions, LlmEndpoint } from './config.ts';
import type { ChatMessage } from './prompt.ts';
import { LLM_CAUSE_IDS, parseVerdict, verdictJsonSchema, type LlmVerdict } from './verdict.ts';

/** llama-server adds these per-request timings to every completion response. */
export interface ServerTimings {
  prompt_n: number;
  prompt_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_second: number;
  cache_n?: number;
}

export interface CallStats {
  wallMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  timings: ServerTimings | null;
}

/**
 * Why a call failed, the same for both clients, so the bench never has to match error strings.
 * The first two are the model's doing and count against a baseline; the last two are
 * infrastructure (rerun the call).
 * - max_tokens: the model used its whole token budget (reasoning included) before the answer ended.
 * - invalid_output: the model finished, but its answer is not a valid verdict.
 * - server_error: the server answered with an HTTP error or a body that is not a completion.
 * - request_failed: no answer at all (connection refused, timeout, client error).
 */
export type FailureKind = 'max_tokens' | 'invalid_output' | 'server_error' | 'request_failed';

export const MAX_TOKENS_ERROR = 'hit max_tokens before the answer finished';

export type VerdictCall =
  | { ok: true; verdict: LlmVerdict; text: string; reasoning: string | null; stats: CallStats }
  | { ok: false; kind: FailureKind; error: string; text: string | null; reasoning: string | null; stats: CallStats };

/** Same shape as the global fetch, so tests can inject a fake and the OpenAI client accepts it. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Builds the Chat Completions body. JSON output is enforced by the server: llama-server turns
 * `response_format.json_schema` into a grammar, so the final answer cannot be anything but the schema.
 */
export function buildChatRequest(
  endpoint: LlmEndpoint,
  messages: readonly ChatMessage[],
  gen: GenerationOptions,
  causeIds: readonly [string, ...string[]] = LLM_CAUSE_IDS,
): Record<string, unknown> {
  return {
    model: endpoint.model,
    messages,
    stream: false,
    temperature: gen.temperature,
    max_tokens: gen.maxTokens,
    seed: gen.seed,
    cache_prompt: gen.cachePrompt,
    chat_template_kwargs: { reasoning_effort: gen.reasoningEffort },
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'diagnosis', strict: true, schema: verdictJsonSchema(causeIds) },
    },
  };
}

interface ChatCompletionBody {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings?: ServerTimings;
  error?: { message?: string };
}

/** Plain fetch client: one non-streaming chat completion, parsed and validated. Never throws. */
export async function fetchVerdict(
  endpoint: LlmEndpoint,
  messages: readonly ChatMessage[],
  gen: GenerationOptions,
  opts: { fetchImpl?: FetchLike; nowMs?: () => number; causeIds?: readonly [string, ...string[]] } = {},
): Promise<VerdictCall> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = opts.nowMs ?? (() => performance.now());
  const causeIds = opts.causeIds ?? LLM_CAUSE_IDS;
  const started = now();
  const stats = (body?: ChatCompletionBody): CallStats => ({
    wallMs: Math.round(now() - started),
    promptTokens: body?.usage?.prompt_tokens ?? null,
    completionTokens: body?.usage?.completion_tokens ?? null,
    timings: body?.timings ?? null,
  });
  const fail = (kind: FailureKind, error: string, body?: ChatCompletionBody, text: string | null = null, reasoning: string | null = null): VerdictCall => ({
    ok: false,
    kind,
    error,
    text,
    reasoning,
    stats: stats(body),
  });

  let res: Response;
  try {
    res = await doFetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify(buildChatRequest(endpoint, messages, gen, causeIds)),
      signal: AbortSignal.timeout(gen.timeoutMs),
    });
  } catch (err) {
    return fail('request_failed', `request failed: ${(err as Error).message}`);
  }

  let body: ChatCompletionBody;
  try {
    body = (await res.json()) as ChatCompletionBody;
  } catch {
    return fail('server_error', `HTTP ${res.status} with a non-JSON body`);
  }
  if (!res.ok) {
    return fail('server_error', `HTTP ${res.status}: ${body.error?.message ?? 'unknown error'}`, body);
  }

  const choice = body.choices?.[0];
  if (!choice) return fail('server_error', 'HTTP 200 without a completion choice', body);
  const text = choice.message?.content ?? '';
  const reasoning = choice.message?.reasoning_content ?? null;
  if (choice.finish_reason === 'length') return fail('max_tokens', MAX_TOKENS_ERROR, body, text, reasoning);
  const parsed = parseVerdict(text, causeIds);
  return parsed.ok
    ? { ok: true, verdict: parsed.verdict, text, reasoning, stats: stats(body) }
    : fail('invalid_output', parsed.error, body, text, reasoning);
}
