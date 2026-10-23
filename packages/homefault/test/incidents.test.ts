// The 20 incidents: reconstructed from dated public reports, each with a verbatim quote, its stated
// assumptions, valid against the format, carrying the evidence its ground truth needs, and in sync
// with the authoring specs they were built from.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAUSE_IDS, checkEvidence, validateScenario } from '../src/index.ts';
import { INCIDENT_IDS, loadIncidents } from '../src/incidents.ts';
import { buildIncident } from '../scripts/incident-kit.ts';
import { INCIDENT_SPECS } from '../scripts/incidents.ts';

const dir = new URL('../incidents/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const incidents = loadIncidents();

describe('incidents', () => {
  it('there are exactly 20, one file each, all loaded by the package', () => {
    expect(files).toHaveLength(20);
    expect(incidents).toHaveLength(20);
    expect(files.map((f) => f.replace(/\.json$/, ''))).toEqual([...INCIDENT_IDS].sort());
  });

  it('every cause in the library is covered', () => {
    expect(new Set(incidents.map((s) => s.ground_truth.cause_id))).toEqual(new Set(CAUSE_IDS));
  });

  it.each(files)('%s is reconstructed from a dated public report with a quote and assumptions', (file) => {
    const raw = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Record<string, unknown>;
    expect(raw.$schema).toBe('../schema/scenario.schema.json');
    const { $schema: _s, ...scenario } = raw;
    const result = validateScenario(scenario);
    expect(result.ok, result.ok ? '' : result.errors.join('\n')).toBe(true);
    if (!result.ok) return;
    const s = result.value;
    expect(s.kind).toBe('incident');
    expect(s.reconstructed).toBe(true);
    expect(s.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(s.source.url).toMatch(/^https:\/\/www\.(reddit\.com\/r\/[a-z]+\/comments\/[a-z0-9]+\/(comment\/[a-z0-9]+\/)?|theverge\.com\/tech\/\d+\/[a-z0-9-]+)$/);
    expect(s.source.date).toMatch(/^202[56]-\d{2}-\d{2}$/);
    expect(s.source.quote?.length ?? 0).toBeGreaterThan(20);
    expect(s.source.quote?.length ?? 0).toBeLessThanOrEqual(400);
    expect(s.source.publisher).toBeTruthy();
    expect(s.noise).toEqual({ jitter_ms: 0, drop_rate: 0 });
    expect(Date.parse(s.now)).toBeLessThanOrEqual(Date.parse('2026-10-15T00:00:00Z'));
    expect(s.id).toBe(file.replace(/\.json$/, ''));
  });

  it.each(incidents.map((s) => [s.id, s] as const))('%s carries the evidence its cause needs', (_id, s) => {
    const r = checkEvidence(s);
    expect(r.missing, r.missing.join('; ')).toEqual([]);
    expect(r.contradictions, r.contradictions.join('; ')).toEqual([]);
  });

  it('files are in sync with scripts/incidents.ts (run npm run incidents after editing a spec)', () => {
    for (const spec of INCIDENT_SPECS) {
      const built = buildIncident(spec);
      const file = JSON.parse(readFileSync(new URL(`${built.id}.json`, dir), 'utf8')) as Record<string, unknown>;
      const { $schema: _s, ...onDisk } = file;
      expect(onDisk).toEqual(JSON.parse(JSON.stringify(built)));
    }
  });

  it('no personal data: no e-mail addresses, user names or phone numbers', () => {
    for (const f of files) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(text).not.toMatch(/\bu\/[A-Za-z0-9_-]+/);
      expect(text).not.toMatch(/\(?\b\d{3}\)?[ .]\d{3}[ .-]\d{4}\b/);
    }
  });
});
