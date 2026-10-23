/** Where the local OpenAI-compatible server lives. Defaults match start-llm.sh. */
export interface LlmEndpoint {
  /** Base URL including /v1, for example http://127.0.0.1:8771/v1 */
  baseUrl: string;
  /** Model alias the server answers to (llama-server --alias). */
  model: string;
  /** llama-server ignores the key unless started with LLM_API_KEY set; the OpenAI client needs a value. */
  apiKey: string;
}

export const DEFAULT_ENDPOINT: LlmEndpoint = {
  baseUrl: 'http://127.0.0.1:8771/v1',
  model: 'gpt-oss-20b',
  apiKey: 'local-no-key',
};

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** Generation settings shared by the Strands and fetch clients so their outputs are comparable. */
export interface GenerationOptions {
  /** 0 = greedy, for reproducible baselines. */
  temperature: number;
  /** Cap on generated tokens, reasoning included. */
  maxTokens: number;
  seed: number;
  reasoningEffort: ReasoningEffort;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /**
   * Let llama-server reuse the KV cache of the previous request's matching prefix. It saves prompt
   * time, but it changes how the prompt is split into batches, and that changes the floating point
   * sums enough to change a greedy answer: the same request gave a different cause_id with and
   * without it, and with it the answer depends on what the previous request left in the slot
   * (results/repro_check.json). Off for the benchmark, so every call is independent of call order.
   */
  cachePrompt: boolean;
}

export const DEFAULT_GENERATION: GenerationOptions = {
  temperature: 0,
  maxTokens: 1024,
  seed: 42,
  reasoningEffort: 'low',
  timeoutMs: 180_000,
  cachePrompt: false,
};

export function endpointFromEnv(env: Readonly<Record<string, string | undefined>>): LlmEndpoint {
  const host = env.LLM_HOST ?? '127.0.0.1';
  const port = env.LLM_PORT ?? '8771';
  return {
    baseUrl: trimSlash(env.LLM_BASE_URL ?? `http://${host}:${port}/v1`),
    model: env.LLM_MODEL ?? DEFAULT_ENDPOINT.model,
    // An empty LLM_API_KEY means "no key" (as in llm-config.sh); the OpenAI client still needs a value.
    apiKey: env.LLM_API_KEY || DEFAULT_ENDPOINT.apiKey,
  };
}

/** The server root (without /v1), where llama-server exposes /health, /tokenize and /completion. */
export function serverRoot(endpoint: LlmEndpoint): string {
  return endpoint.baseUrl.replace(/\/v1$/, '');
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
