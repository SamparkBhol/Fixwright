// Smoke test: the Strands Agents SDK (OpenAI-compatible provider) talks to the local llama-server and
// gets back a JSON diagnosis {cause_id, confidence, explanation} that parses and validates. A plain
// fetch client asks the same question for comparison.
//
// Usage (server must be up: ./start-llm.sh):
//   node bench/llm/strands_smoke.ts [--runs 3] [--out bench/llm/results/strands_smoke.json]
// Exit code 0 only if every primary Strands call and every fetch call parsed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_GENERATION, endpointFromEnv, serverRoot, type LlmEndpoint } from './src/config.ts';
import { fetchVerdict, type VerdictCall } from './src/fetch-client.ts';
import { HALLWAY_LAMP_CASE } from './src/fixtures.ts';
import { diagnosisMessages } from './src/prompt.ts';
import { strandsVerdict, type StrandsJsonMode } from './src/strands-client.ts';

type ClientName = `strands:${StrandsJsonMode}` | 'fetch:json_schema';

interface SmokeRow {
  client: ClientName;
  run: number;
  ok: boolean;
  /** Failure kind (max_tokens, invalid_output, server_error, request_failed), the same for every client. */
  kind: string | null;
  error: string | null;
  cause_id: string | null;
  confidence: number | null;
  explanation: string | null;
  matches_expected_cause: boolean | null;
  wall_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

/** The mode the bench uses; the other Strands mode is reported for comparison only. */
const PRIMARY_STRANDS_MODE: StrandsJsonMode = 'json_schema';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: '1' },
      out: { type: 'string', default: resolve(here, 'results/strands_smoke.json') },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  const endpoint = endpointFromEnv(process.env);
  await assertHealthy(endpoint);

  const gen = DEFAULT_GENERATION;
  const clients: [ClientName, () => Promise<VerdictCall>][] = [
    ['strands:json_schema', () => strandsVerdict(endpoint, HALLWAY_LAMP_CASE, gen, 'json_schema')],
    ['strands:structured_output', () => strandsVerdict(endpoint, HALLWAY_LAMP_CASE, gen, 'structured_output')],
    ['fetch:json_schema', () => fetchVerdict(endpoint, diagnosisMessages(HALLWAY_LAMP_CASE), gen)],
  ];

  const rows: SmokeRow[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const [client, call] of clients) {
      const r = await call();
      const row = toRow(client, run, r);
      rows.push(row);
      console.log(formatRow(row));
    }
  }

  const required = rows.filter((r) => r.client === `strands:${PRIMARY_STRANDS_MODE}` || r.client === 'fetch:json_schema');
  const passed = required.every((r) => r.ok);
  const report = {
    generated_at: new Date().toISOString(),
    endpoint: endpoint.baseUrl,
    model: endpoint.model,
    generation: gen,
    case: { symptom: HALLWAY_LAMP_CASE.symptom, expected_cause: HALLWAY_LAMP_CASE.expectedCause },
    primary_strands_mode: PRIMARY_STRANDS_MODE,
    passed,
    summary: summarize(rows),
    rows,
  };
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${passed ? 'PASS' : 'FAIL'}: ${required.filter((r) => r.ok).length}/${required.length} required calls parsed. Report: ${values.out}`);
  return passed ? 0 : 1;
}

async function assertHealthy(endpoint: LlmEndpoint): Promise<void> {
  const url = `${serverRoot(endpoint)}/health`;
  let status = 0;
  try {
    status = (await fetch(url, { signal: AbortSignal.timeout(3000) })).status;
  } catch {
    status = 0;
  }
  if (status !== 200) {
    throw new Error(`LLM server not healthy at ${url} (status ${status || 'no answer'}). Start it with bench/llm/start-llm.sh.`);
  }
}

function toRow(client: ClientName, run: number, r: VerdictCall): SmokeRow {
  return {
    client,
    run,
    ok: r.ok,
    kind: r.ok ? null : r.kind,
    error: r.ok ? null : r.error,
    cause_id: r.ok ? r.verdict.cause_id : null,
    confidence: r.ok ? r.verdict.confidence : null,
    explanation: r.ok ? r.verdict.explanation : null,
    matches_expected_cause: r.ok ? r.verdict.cause_id === HALLWAY_LAMP_CASE.expectedCause : null,
    wall_ms: r.stats.wallMs,
    prompt_tokens: r.stats.promptTokens,
    completion_tokens: r.stats.completionTokens,
  };
}

function summarize(rows: readonly SmokeRow[]) {
  const names = [...new Set(rows.map((r) => r.client))];
  return names.map((client) => {
    const mine = rows.filter((r) => r.client === client);
    const ok = mine.filter((r) => r.ok);
    return {
      client,
      calls: mine.length,
      parsed: ok.length,
      matched_expected_cause: ok.filter((r) => r.matches_expected_cause).length,
      mean_wall_ms: Math.round(mine.reduce((s, r) => s + r.wall_ms, 0) / mine.length),
    };
  });
}

function formatRow(r: SmokeRow): string {
  const head = `[${r.client} #${r.run}] ${r.ok ? 'parsed' : 'FAILED'} in ${r.wall_ms} ms (prompt ${r.prompt_tokens ?? '?'} tok, output ${r.completion_tokens ?? '?'} tok)`;
  return r.ok ? `${head}\n  cause_id=${r.cause_id} confidence=${r.confidence}\n  ${r.explanation}` : `${head}\n  ${r.kind}: ${r.error}`;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
