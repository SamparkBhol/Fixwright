// Prints the default demo house the way an agent would first see it. Every number below is read from
// the simulation. Run: npm run demo  (or: node scripts/demo.ts [seed])

import { SimHome, localClock, type HouseEvent } from '../src/index.ts';

const seed = Number(process.argv[2] ?? 1);
const home = SimHome.create({ seed });
const tz = home.tz;
const at = (ts: string): string => localClock(Date.parse(ts), tz);

const entities = await home.listEntities();
console.log(`SimHome seed ${seed}, ${tz}, now ${home.now()} (${at(home.now())} local)`);
console.log(`${entities.length} entities in ${new Set(entities.map((e) => e.area).filter(Boolean)).size} areas, faults: ${home.activeFaults().join(', ')}`);

const lamps = entities.filter((e) => e.name === 'Hallway Lamp');
for (const e of lamps) console.log(`  F1 ${e.entityId}: ${e.state}${e.restored ? ' (restored)' : ''}, last changed ${e.lastChanged}`);
console.log(`  F1 the name "Hallway Lamp" reaches ${home.resolveName('hallway lamp')?.entityId}`);

const night = await home.events({ since: '2026-10-15T10:00:00Z', until: '2026-10-15T10:59:59Z' });
const cluster = night.filter((e: HouseEvent) => e.kind === 'availability' || e.kind === 'power');
const turnedOn = night.filter((e) => e.kind === 'availability' && e.from === 'unavailable' && e.to === 'on');
console.log(`  F2 ${cluster.length} availability/power events between 03:00 and 03:59; ${turnedOn.length} entities came back on:`);
for (const e of turnedOn) console.log(`     ${at(e.ts)} ${e.entityId} ${e.from} -> ${e.to}${e.context ? ` context ${JSON.stringify(e.context)}` : ''}`);
console.log(`  F2 automation runs in that hour: ${night.filter((e) => e.kind === 'automation_run').length}`);

const deviceOf = new Map(entities.flatMap((e) => (e.deviceId ? [[e.entityId, e.deviceId] as const] : [])));
const firstBack = new Map<string, number>();
for (const e of night) {
  const back = (e.kind === 'availability' && e.from === 'unavailable') || (e.kind === 'power' && e.data?.reason === 'PowerOnReboot');
  if (!back || !e.entityId) continue;
  const device = deviceOf.get(e.entityId) ?? e.entityId;
  firstBack.set(device, Math.min(Date.parse(e.ts), firstBack.get(device) ?? Infinity));
}
const backTimes = [...firstBack.values()];
console.log(`  F2 ${firstBack.size} devices restarted, first to last ${((Math.max(...backTimes) - Math.min(...backTimes)) / 1000).toFixed(3)} s`);

const kitchen = await home.signals('switch.kitchen_plug');
console.log(`  F4 kitchen plug: ${kitchen.flaps24h} drops in 24 h, RSSI ${kitchen.rssi}`);
console.log(`  F3 lights named Living Room Light: ${entities.filter((e) => e.name === 'Living Room Light').map((e) => e.entityId).join(', ')}`);
console.log(`  F5 hall motion battery ${(await home.signals('binary_sensor.hall_motion')).batteryPct}%`);
for (const id of ['switch.reading_lamp', 'switch.aquarium_filter', 'switch.phone_charger', 'switch.printer', 'switch.speakers', 'switch.paper_shredder']) {
  const e = entities.find((x) => x.entityId === id);
  console.log(`  ${String(e?.attributes.power_strip)} outlet ${e?.attributes.outlet}: ${e?.name} is ${e?.state}`);
}
console.log(`  snapshot ${new TextEncoder().encode(JSON.stringify(home.snapshot())).length} bytes, ${home.rows().length} log rows`);

home.advanceTo('2026-10-16T07:00:00');
const morning = await home.signals('switch.kitchen_plug');
const battery = (await home.signals('binary_sensor.hall_motion')).batteryPct;
console.log(`Next morning ${home.now()} (${at(home.now())} local): kitchen plug ${morning.flaps24h} drops in 24 h, hall motion battery ${battery}%, reading lamp ${(await home.getEntity('switch.reading_lamp'))?.state}`);
