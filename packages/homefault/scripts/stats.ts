// Prints the measured facts the README quotes. Run: npm run stats

import { CAUSE_IDS, SimHome, checkEvidence, generateScenario, generateSet, seedsOf, type Scenario } from '../src/index.ts';
import { loadIncidents } from '../src/incidents.ts';

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

function describeSet(name: string, set: Scenario[], clean: Scenario[]): void {
  const counts = Object.fromEntries(CAUSE_IDS.map((c) => [c, set.filter((s) => s.ground_truth.cause_id === c).length]));
  console.log(`${name}: ${set.length} scenarios, per cause ${JSON.stringify(counts)}`);
  console.log(`  drop rate mean ${mean(set.map((s) => s.noise.drop_rate)).toFixed(3)}, min ${Math.min(...set.map((s) => s.noise.drop_rate))}, max ${Math.max(...set.map((s) => s.noise.drop_rate))}`);
  console.log(`  jitter mean ${Math.round(mean(set.map((s) => s.noise.jitter_ms)))} ms, max ${Math.max(...set.map((s) => s.noise.jitter_ms))} ms`);
  console.log(`  rows mean ${Math.round(mean(set.map((s) => s.events.length)))}, entities mean ${Math.round(mean(set.map((s) => s.home.entities.length)))}`);
  console.log(`  evidence complete: ${clean.filter((s) => checkEvidence(s).supported).length}/${clean.length} without noise, ${set.filter((s) => checkEvidence(s).supported).length}/${set.length} with noise`);
}

const t0 = performance.now();
const dev = generateSet('dev');
const heldout = generateSet('heldout');
const ms = performance.now() - t0;
describeSet('dev', dev, seedsOf('dev').map((s) => generateScenario(s, { noise: false })));
describeSet('heldout', heldout, seedsOf('heldout').map((s) => generateScenario(s, { noise: false })));
console.log(`generated 700 scenarios in ${Math.round(ms)} ms`);

const incidents = loadIncidents();
console.log(`incidents: ${incidents.length}, evidence complete ${incidents.filter((s) => checkEvidence(s).supported).length}/${incidents.length}`);
console.log(`  per cause ${JSON.stringify(Object.fromEntries(CAUSE_IDS.map((c) => [c, incidents.filter((s) => s.ground_truth.cause_id === c).length])))}`);
console.log(`  dates ${incidents.map((s) => s.source.date).sort()[0]} to ${incidents.map((s) => s.source.date).sort().at(-1)}`);

const home = SimHome.create({ seed: 1 });
const entities = await home.listEntities();
const snapshot = home.snapshot();
const devices = Object.values(snapshot.devices);
const present = devices.filter((d) => d.present).length;
const strips = devices.filter((d) => d.kind === 'strip').length;
console.log(
  `demo house: ${entities.length} entities, ${present} physical devices (plus ${devices.length - present} old pairing that no longer answers), ${strips} power strips, snapshot ${new TextEncoder().encode(JSON.stringify(snapshot)).length} bytes`,
);
home.advance(7 * 86_400_000);
console.log(`  after 7 simulated days: snapshot ${new TextEncoder().encode(JSON.stringify(home.snapshot())).length} bytes, ${home.rows().length} rows, log ${home.snapshot().rowBytes} of ${home.snapshot().maxRowBytes} bytes`);
const t1 = performance.now();
for (let seed = 1; seed <= 20; seed++) SimHome.create({ seed });
console.log(`  SimHome.create: ${((performance.now() - t1) / 20).toFixed(1)} ms each (mean of 20)`);
