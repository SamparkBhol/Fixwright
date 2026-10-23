import {
  Agent,
  ContextWindowOverflowError,
  MaxTokensError,
  StructuredOutputError,
  type AgentResult,
  type Message,
} from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type { GenerationOptions, LlmEndpoint } from './config.ts';
import { MAX_TOKENS_ERROR, type CallStats, type FetchLike, type VerdictCall } from './fetch-client.ts';
import type { DiagnosisInput } from './prompt.ts';
import { systemPrompt, userPrompt } from './prompt.ts';
import { LLM_CAUSE_IDS, parseVerdict, validateVerdict, verdictJsonSchema, verdictSchema } from './verdict.ts';

/**
 * How the Strands agent is asked for JSON.
 * - json_schema: the model provider passes `response_format: json_schema` through `params`, so
 *   llama-server constrains the final answer with a grammar; the agent's text is then parsed.
 * - structured_output: Strands' own structuredOutputSchema, which registers a tool the model must call.
 */
export type StrandsJsonMode = 'json_schema' | 'structured_output';

export interface StrandsClientOptions {
  /** Injected fetch for tests; production uses the global fetch. */
  fetchImpl?: FetchLike;
  causeIds?: readonly [string, ...string[]];
}

/**
 * The Strands OpenAI provider pointed at the local llama-server. Chat Completions (`api: 'chat'`)
 * because llama-server implements /v1/chat/completions; extra llama.cpp fields ride in `params`.
 */
export function createLocalModel(
  endpoint: LlmEndpoint,
  gen: GenerationOptions,
  mode: StrandsJsonMode,
  opts: StrandsClientOptions = {},
): OpenAIModel {
  const params: Record<string, unknown> = {
    seed: gen.seed,
    cache_prompt: gen.cachePrompt,
    chat_template_kwargs: { reasoning_effort: gen.reasoningEffort },
  };
  if (mode === 'json_schema') {
    params.response_format = {
      type: 'json_schema',
      json_schema: { name: 'diagnosis', strict: true, schema: verdictJsonSchema(opts.causeIds ?? LLM_CAUSE_IDS) },
    };
  }
  return new OpenAIModel({
    api: 'chat',
    modelId: endpoint.model,
    apiKey: endpoint.apiKey,
    clientConfig: {
      baseURL: endpoint.baseUrl,
      timeout: gen.timeoutMs,
      maxRetries: 0,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    },
    temperature: gen.temperature,
    maxTokens: gen.maxTokens,
    params,
  });
}

/** One stateless diagnosis call through a fresh Strands Agent. Never throws. */
export async function strandsVerdict(
  endpoint: LlmEndpoint,
  input: DiagnosisInput,
  gen: GenerationOptions,
  mode: StrandsJsonMode,
  opts: StrandsClientOptions = {},
): Promise<VerdictCall> {
  const causeIds = opts.causeIds ?? LLM_CAUSE_IDS;
  const agent = new Agent({
    model: createLocalModel(endpoint, gen, mode, opts),
    systemPrompt: systemPrompt(),
    printer: false,
    // The bench measures each call as made; a silent retry would hide failures and skew latency.
    retryStrategy: null,
  });
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let result: AgentResult;
  try {
    result =
      mode === 'structured_output'
        ? await agent.invoke(userPrompt(input), { structuredOutputSchema: verdictSchema(causeIds) })
        : await agent.invoke(userPrompt(input));
  } catch (err) {
    return failureFromError(err, elapsed());
  }
  const usage = result.metrics?.accumulatedUsage;
  const stats: CallStats = {
    wallMs: elapsed(),
    promptTokens: usage?.inputTokens ?? null,
    completionTokens: usage?.outputTokens ?? null,
    timings: null,
  };
  const text = resultText(result);
  const parsed = mode === 'structured_output' ? validateVerdict(result.structuredOutput, causeIds) : parseVerdict(text, causeIds);
  return parsed.ok
    ? { ok: true, verdict: parsed.verdict, text: text || JSON.stringify(result.structuredOutput), reasoning: null, stats }
    : { ok: false, kind: 'invalid_output', error: parsed.error, text, reasoning: null, stats };
}

/**
 * Maps what Strands throws onto the same failure kinds the fetch client reports. Strands never
 * returns a result with stopReason 'maxTokens': the model layer throws MaxTokensError instead,
 * carrying the partial message and its token usage.
 */
export function failureFromError(err: unknown, wallMs: number): VerdictCall {
  const noStats: CallStats = { wallMs, promptTokens: null, completionTokens: null, timings: null };
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof MaxTokensError) {
    const usage = err.partialMessage.metadata?.usage;
    const stats: CallStats = { ...noStats, promptTokens: usage?.inputTokens ?? null, completionTokens: usage?.outputTokens ?? null };
    return { ok: false, kind: 'max_tokens', error: MAX_TOKENS_ERROR, text: messageText(err.partialMessage), reasoning: null, stats };
  }
  if (err instanceof StructuredOutputError) {
    return { ok: false, kind: 'invalid_output', error: `structured output: ${message}`, text: null, reasoning: null, stats: noStats };
  }
  if (err instanceof ContextWindowOverflowError) {
    return { ok: false, kind: 'server_error', error: `prompt does not fit the context window: ${message}`, text: null, reasoning: null, stats: noStats };
  }
  const status = httpStatusOf(err);
  if (status !== null) {
    // The OpenAI SDK message starts with the status ("401 Invalid API Key"); drop it so both clients say the same.
    const detail = message.replace(new RegExp(`^${status}\\s+`), '');
    return { ok: false, kind: 'server_error', error: `HTTP ${status}: ${detail}`, text: null, reasoning: null, stats: noStats };
  }
  return { ok: false, kind: 'request_failed', error: `strands invoke failed: ${message}`, text: null, reasoning: null, stats: noStats };
}

/** HTTP status of an OpenAI SDK APIError, directly or wrapped as the cause of a Strands error. */
function httpStatusOf(err: unknown): number | null {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

/** Text blocks of the final assistant message (reasoning stays out of `content` on llama-server). */
export function resultText(result: AgentResult): string {
  return messageText(result.lastMessage);
}

function messageText(message: Message): string {
  return message.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])).join('');
}
