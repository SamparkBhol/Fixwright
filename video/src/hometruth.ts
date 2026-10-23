// The benchmark card's numbers, read from a HomeTruth result file (bench/results). Pure: JSON in, flat
// {"heldout.b1.right": "71", ...} out, so no number on the card is typed by hand.

interface Rate {
  k: number;
  n: number;
  value: number;
}

interface AgentMetrics {
  n: number;
  answered: number;
  top1: Rate;
  top1_answered: Rate;
  abstention: Rate;
}

export interface HomeTruthResult {
  format: string;
  config: { set: string; n: number; seed: number };
  metrics: Record<string, { all: AgentMetrics }>;
}

export const AGENTS = ['fixwright', 'b1', 'b2'] as const;

export function cardValues(r: HomeTruthResult): Record<string, string> {
  if (r.format !== 'hometruth.results/1') throw new Error(`unknown HomeTruth result format ${r.format}`);
  const set = r.config.set;
  const out: Record<string, string> = { [`${set}.n`]: String(r.config.n), [`${set}.seed`]: String(r.config.seed) };
  for (const agent of AGENTS) {
    const m = r.metrics[agent]?.all;
    if (!m) throw new Error(`HomeTruth result has no metrics for ${agent}`);
    const wrong = m.answered - m.top1.k;
    if (m.top1.k + m.abstention.k + wrong !== m.n) throw new Error(`${agent}: right, can't tell and wrong do not add up to ${m.n}`);
    const key = `${set}.${agent}`;
    out[`${key}.right`] = String(m.top1.k);
    out[`${key}.cant_tell`] = String(m.abstention.k);
    out[`${key}.wrong`] = String(wrong);
    out[`${key}.answered`] = String(m.answered);
    out[`${key}.right_when_answered`] = `${Math.round(m.top1_answered.value * 100)}%`;
  }
  return out;
}
