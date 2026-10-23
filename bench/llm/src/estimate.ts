/** Throughput measured on the local server, in tokens per second. */
export interface Throughput {
  promptTokensPerSecond: number;
  generationTokensPerSecond: number;
}

export interface CallShape {
  promptTokens: number;
  outputTokens: number;
  /** Fixed per-call cost outside the model: HTTP, template rendering, JSON parse. */
  overheadMs?: number;
}

/** Time for one call: prompt processing plus generation plus overhead, in milliseconds. */
export function estimateCallMs(shape: CallShape, tp: Throughput): number {
  if (tp.promptTokensPerSecond <= 0 || tp.generationTokensPerSecond <= 0) {
    throw new RangeError('throughput must be positive');
  }
  const promptMs = (shape.promptTokens / tp.promptTokensPerSecond) * 1000;
  const genMs = (shape.outputTokens / tp.generationTokensPerSecond) * 1000;
  return promptMs + genMs + (shape.overheadMs ?? 0);
}

export interface RunEstimate {
  calls: number;
  perCallMs: number;
  totalMs: number;
  totalMinutes: number;
}

/** Wall time for `calls` sequential calls of the same shape (one server slot, no batching). */
export function estimateRun(calls: number, shape: CallShape, tp: Throughput): RunEstimate {
  if (!Number.isInteger(calls) || calls < 0) throw new RangeError('calls must be a non-negative integer');
  const perCallMs = estimateCallMs(shape, tp);
  const totalMs = perCallMs * calls;
  return { calls, perCallMs: round1(perCallMs), totalMs: Math.round(totalMs), totalMinutes: round1(totalMs / 60_000) };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
