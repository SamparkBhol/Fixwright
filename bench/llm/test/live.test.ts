// Live check against the real llama-server. Skipped unless FIXWRIGHT_LLM_LIVE=1, so `npm run check`
// stays fast and offline. Run: ./start-llm.sh && FIXWRIGHT_LLM_LIVE=1 npx vitest run test/live.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERATION, endpointFromEnv } from '../src/config.ts';
import { fetchVerdict, MAX_TOKENS_ERROR } from '../src/fetch-client.ts';
import { HALLWAY_LAMP_CASE } from '../src/fixtures.ts';
import { diagnosisMessages } from '../src/prompt.ts';
import { strandsVerdict } from '../src/strands-client.ts';

const live = process.env.FIXWRIGHT_LLM_LIVE === '1';
const endpoint = endpointFromEnv(process.env);

describe.skipIf(!live)('local gpt-oss-20b (live)', () => {
  it('Strands json_schema mode returns a valid verdict', { timeout: 240_000 }, async () => {
    const r = await strandsVerdict(endpoint, HALLWAY_LAMP_CASE, DEFAULT_GENERATION, 'json_schema');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
  });

  it('plain fetch client returns a valid verdict', { timeout: 240_000 }, async () => {
    const r = await fetchVerdict(endpoint, diagnosisMessages(HALLWAY_LAMP_CASE), DEFAULT_GENERATION);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
  });

  it('both clients report a truncated answer the same way (max_tokens)', { timeout: 240_000 }, async () => {
    const gen = { ...DEFAULT_GENERATION, maxTokens: 16 };
    const viaStrands = await strandsVerdict(endpoint, HALLWAY_LAMP_CASE, gen, 'json_schema');
    const viaFetch = await fetchVerdict(endpoint, diagnosisMessages(HALLWAY_LAMP_CASE), gen);
    expect(viaStrands).toMatchObject({ ok: false, kind: 'max_tokens', error: MAX_TOKENS_ERROR });
    expect(viaFetch).toMatchObject({ ok: false, kind: 'max_tokens', error: MAX_TOKENS_ERROR });
    expect(viaStrands.stats.completionTokens).toBe(16);
    expect(viaFetch.stats.completionTokens).toBe(16);
  });
});
