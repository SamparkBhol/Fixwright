# homefault

**Break a smart home on purpose. Then check whether your agent can prove what broke.**

When a smart home agent says "the hallway lamp is offline because an old copy of it still owns the
name", nobody can check that answer on a real house, because a real house has no ground truth.
homefault gives any smart home agent houses where the truth is known, so a diagnosis can be scored
before a person ever hears it, and a confident wrong answer shows up as a number instead of a support
ticket.

It is behavioural fault injection for smart home agents: a house you can break (a deterministic
digital twin), ten real world faults to break it with, a scenario format for frozen broken homes, a
generator that makes hundreds of them, twenty incidents reconstructed from dated public reports, and a
benchmark runner that scores an agent's diagnosis, including how often it says "confirmed" and is
wrong.

MIT licensed. Pure TypeScript with no runtime dependencies: runs unchanged in Node 22, Cloudflare
Workers (workerd) and the browser. It also ships a small Home Assistant configuration with a simulated
hallway circuit and a fault injector, so the same faults can be reproduced on a real Home Assistant.

## Prove a diagnosis in three steps

1. **Point your agent at SimHome.** It speaks the same `HomeAdapter` shape a Home Assistant adapter
   does (entities, events with contexts, signals, integration states, service calls), so the agent
   runs unchanged. Inject a fault, ask your question, and compare the answer with
   `home.physical(id)`, the ground truth the hub never sees.
2. **Score it on scenarios.** `runBench(agent, scenarios)` runs the agent over generated houses and the
   twenty incidents, answers its questions to the person in the room from the scenario's human truth,
   and counts right causes, false confirmations, abstentions and disruptive probes.
3. **Reproduce it on a real Home Assistant.** `fixtures/home-assistant/` breaks a real instance with the
   same kinds of faults (an unavailable device, a ghost copy, a duplicate name, a power cut, power-on
   behaviour, a bridge going down), so the agent's live adapter path is checked too.

## Install

homefault is published as TypeScript source (`"exports": "./src/index.ts"`). Use it from a bundler
(esbuild, Vite, wrangler) or from Node 22.18 or later, which runs `.ts` files directly.

```sh
git clone https://github.com/SamparkBhol/Fixwright/tree/main/packages/homefault homefault && cd homefault
npm ci
npm run check     # typecheck (src without Node types, then everything) and 359 tests
npm run demo      # the demo house as an agent first sees it
```

To use it from your own project, pin a release tag. Node does not strip types from files inside
`node_modules`, so for scripts that Node runs directly, add homefault as a git submodule and list it as
an npm workspace (the workspace link points outside `node_modules`):

```sh
git submodule add https://github.com/SamparkBhol/Fixwright/tree/main/packages/homefault packages/homefault
git -C packages/homefault checkout v0.1.0
# package.json: "workspaces": ["packages/*"], and "homefault": "*" in the packages that import it
```

## Why

Smart home assistants are now asked *why* things happen: "why does the hallway lamp keep saying it's
not responding?", "why did every plug turn on at 3 a.m.?". The honest answers live in the home's own
logs (availability transitions, contexts, integration states, power-on settings) and sometimes only in
the room ("did it blink?"). An agent that answers from vibes produces the reply one person posted
about on 23 September 2026:

> "might have been a power failure or a router problem"
> ([r/alexa](https://www.reddit.com/r/alexa/comments/1wo3p68/))

An agent that diagnoses has to show its evidence, ask the person when no sensor can answer, and say
"can't tell" when the evidence is not there. You cannot measure that on a live house: you never know
the ground truth. homefault gives you houses where you do.

## What is in the box

| Piece | What it is |
| --- | --- |
| **SimHome** | A digital twin implementing the standard `HomeAdapter` shape on virtual time. Physical truth (mains circuits, wall switches, radio links, a UPS, relays) is separate from what the hub observes, and faults live in the gap. Home Assistant shaped logs with contexts, restored entities, signals, integration states. `snapshot()` / `restore()` as JSON. |
| **10 faults** | F1 to F10, each tied to a cause, the checkup finding it should raise, what a person in the room would see, and the dated public report it was modelled on. |
| **Scenario format** | One broken home frozen at the moment someone asks for help. JSON Schema in `schema/scenario.schema.json`. |
| **Generator** | An event level simulator, separate from SimHome and from any agent: random houses, every cause, timing jitter, dropped log rows (0 to 15%), correlated failures and distractors. Seeded; dev and held out splits. |
| **20 incidents** | Hand written scenarios reconstructed from dated public reports, each with a verbatim quote and its assumptions stated. |
| **Bench** | `runBench(agent, scenarios, { humanReliability })`: top-1 accuracy, false confirmations, abstention, probes, disruptive probes, questions asked, latency. The person in the room is simulated, with a reliability knob. |
| **Home Assistant fixtures** | `fixtures/home-assistant/`: a Home Assistant 2026.9.4 config with a simulated hallway circuit (mains breaker, radio link, a dead old pairing, power-on behaviour selects, a simulated bridge integration), headless onboarding, and `inject.ts` for unavailable, ghost, duplicate name, power cut, power-on behaviour and bridge down. See its README. |

## Quick start

```ts
import { SimHome, runBench, generateSet } from 'homefault';
import { loadIncidents } from 'homefault/incidents';

// The default demo house: 15 Oct 2026, 15:00 in Los Angeles, five faults already in its history.
const home = SimHome.create({ seed: 1 });

// Talk to it exactly like a Home Assistant adapter.
const lamps = (await home.listEntities()).filter((e) => e.name === 'Hallway Lamp');
const night = await home.events({ since: '2026-10-15T10:00:00Z', until: '2026-10-15T10:59:59Z' });
const plug = await home.signals('switch.kitchen_plug'); // { rssi: -82, flaps24h: 9, ... }

// Physical reality is enforced: the old copy rejects, the working lamp blinks.
await home.callService('light', 'turn_on', { entity_id: 'light.hallway_lamp_2', flash: 'short' });
home.person({ kind: 'confirm_flash', name: 'Hallway Lamp' }); // 'yes'

// Break it some more, move time, keep it in a Durable Object.
home.inject('F10');              // the Wi-Fi router changed
home.advance(8 * 3_600_000);     // eight hours of resident, automations and faults
const saved = home.snapshot();   // plain JSON, restore(saved) continues byte for byte

// Score an agent.
const agent = {
  name: 'my-agent',
  async diagnose(view, askHuman) {
    const answer = await askHuman({ kind: 'confirm_flash', text: "I'll flash it twice. Did it blink?" });
    return { cause_id: answer === 'yes' ? 'stale_duplicate' : 'device_power_lost', level: 'likely' };
  },
};
const result = await runBench(agent, [...loadIncidents(), ...generateSet('heldout')], { humanReliability: 0.9 });
console.log(result.metrics);
```

Try it from a checkout: `npm run demo` prints the demo house as an agent first sees it.

## The demo house

`SimHome.create()` with no options builds the default demo house: six areas (hallway, living room,
kitchen, bedroom, office, garage), each on its own mains circuit, with the hub, Zigbee coordinator, Hue
bridge, Thread border router and Wi-Fi router on a UPS. 27 physical devices from zigbee2mqtt, hue, kasa
(Wi-Fi), matter (Thread), ecobee (cloud) and template/automation, including two Wi-Fi power strips with
three child outlets each, make 47 entities: 33 everyday entities (including the old copy F1 leaves
behind, whose pairing no longer answers) plus 14 power-on-behavior config selects, which are what a
power-on repair writes to. A
resident uses voice and the app every day, four automations and a night mode template run on schedule,
and the history of the last 24 hours is simulated, not painted.

The clock starts at 2026-10-15T15:00:00 America/Los_Angeles with these faults in its history (all read
back from the simulation in `test/demo-house.test.ts`, for six seeds):

| Fault | What the logs show |
| --- | --- |
| F1 | "Hallway Lamp" reaches `light.hallway_lamp`, a restored copy offline since 3 October; the newly paired `light.hallway_lamp_2` is online under the same name. The lamp is a bridge maker's bulb paired straight to Zigbee2MQTT (the demo house names no brands; its maker maps to the `hue` integration), so its vendor cloud has a status, and it is fine. |
| F2 | Mains power out at 03:11:58, back at 03:12:00; 14 Zigbee and Matter lights and plugs come back `on`, all within four seconds of the power; first to last restart takes over three and at most four seconds (3.29 to 3.52 s over seeds 1 to 500); no automation, user or service context. |
| F3 | A Hue room and a Zigbee floor lamp are both named "Living Room Light". |
| F4 | The kitchen plug dropped off Wi-Fi 9 times today, all between 09:00 and 15:00; RSSI -82 dBm. |
| F5 | The hall motion sensor battery is at 6%. |

The aquarium filter runs on outlet 2 of the living room power strip, a reading lamp on outlet 1 (on in
the early morning and from early afternoon to bedtime), a phone charger on outlet 3. The office strip
feeds a printer, speakers and a paper shredder.

Once the hallway lamp is repaired in the afternoon, it receives exactly nine commands before 07:00 the
next morning (four by voice in the evening, two night light runs, one by voice at dawn), so the repair
can be checked against what really happened overnight. The flash test and the repair's own read back
(switch on, switch off) do not count: every write is one API round trip of virtual time, so they all
sit before the moment the repair finishes.

### What holds after a jump to the next morning

A demo that repairs the lamp at 15:00 and then jumps the clock to 07:00 on 16 October can rely on the
list below. Measured for seeds 1 to 500 on 15 October 2026, with one diagnosis engine (Fixwright's,
see [Used by](#used-by)) driving the house:

- True at 15:00: hub reachable, signal good, Hue cloud fine, so two causes remain for the hallway lamp.
- Still true at 07:00: the 9 overnight commands, the kitchen plug's 9 drops in the last 24 hours (they
  stay 9 from 15:00 until 09:00 the next morning, because the plug only drops off in the daytime), the
  battery at 6% (it loses 0.4% a day), the two Living Room Lights, and the reading lamp being on (so a
  refused strip switch off can offer "the lamp" instead).
- Not true at 07:00: "at 3 a.m." now means 3 a.m. on 16 October, a quiet night. The outage is in the
  night before the demo. Ask about it before the jump, or pass that night's window (03:00 to 03:59 on
  15 October). An outage on the night of the repair would make the lamp go offline overnight and fail
  the morning check, so it cannot move.
- The 9 drops happened on 15 October, so after the jump they are yesterday's. A checkup that phrases by
  calendar day says "in the last day" rather than "today"; run the checkup before the jump to hear
  "today".

## The ten faults

| Code | Id | Cause | Finding | Modelled on |
| --- | --- | --- | --- | --- |
| F1 | `ghost_after_repair` | `stale_duplicate` | ghost_entity | [r/alexa, 9 Sep 2026](https://www.reddit.com/r/alexa/comments/1wbmeqx/); [The Verge, 8 Oct 2026](https://www.theverge.com/tech/1007565/amazon-alexa-plus-review-one-year-echo-show-dot-max) |
| F2 | `power_restore_default_on` | `power_on_default_on` | power_on_default | [r/alexa, 23 Sep 2026](https://www.reddit.com/r/alexa/comments/1wo3p68/) |
| F3 | `duplicate_spoken_name` | `name_collision` | duplicate_name | [r/alexa, 2 Jul 2025](https://www.reddit.com/r/alexa/comments/1lpzsqw/) |
| F4 | `wifi_flapping` | `radio_link_weak` | flapping | [r/amazonecho, 7 Jul 2026](https://www.reddit.com/r/amazonecho/comments/1uq82cv/) |
| F5 | `low_battery` | `device_power_lost` | low_battery | no matching dated report; kept as the maintenance case a checkup must catch |
| F6 | `vendor_cloud_outage` | `vendor_cloud_outage` | none | [r/alexa, 19 Jan 2026](https://www.reddit.com/r/alexa/comments/1qh9utk/) (same pattern, Hue instead of ecobee) |
| F7 | `account_link_expired` | `account_link_expired` | integration_error | [r/alexa, 23 Jul 2026](https://www.reddit.com/r/alexa/comments/1v4cetj/) |
| F8 | `hub_down` | `hub_down` | integration_error | [r/alexa, 14 Jan 2026](https://www.reddit.com/r/alexa/comments/1qcuymd/) |
| F9 | `dead_trigger` | `dead_trigger` | dead_trigger | [r/alexa, 26 Apr 2026](https://www.reddit.com/r/alexa/comments/1sw9b83/) |
| F10 | `router_ssid_change` | `wifi_network_changed` | none | [r/alexa, 10 Oct 2026](https://www.reddit.com/r/alexa/comments/1x25meq/); [r/alexa, 3 Oct 2026](https://www.reddit.com/r/alexa/comments/1wwbpd3/) |

`inject(id or code, opts?)` changes physical truth or configuration at the current virtual time and lets
the house show the consequences through its normal logs. `clear()` undoes it the way the real fix would
(rename, relink, battery swap, onboarding again). Every fault is tested to produce the evidence its cause
needs and nothing that contradicts it, and to leave a healthy house when cleared.

## The scenario format

A scenario is one JSON file (`schema/scenario.schema.json`, JSON Schema 2020-12):

```jsonc
{
  "format": "homefault.scenario/1",
  "id": "inc-04-all-plugs-turned-on",
  "title": "Every plug and light was on in the morning, and the activity log was empty",
  "kind": "incident",                       // incident | generated | twin
  "source": { "url": "https://www.reddit.com/r/alexa/comments/1wo3p68/", "date": "2026-09-23",
              "quote": "Got up this morning and noticed all my devices attached to plugs were turned on. ...",
              "publisher": "Reddit r/alexa" },
  "reconstructed": true,
  "assumptions": ["Replies to the post suggested a power cut. We model a three second outage at 02:47 ..."],
  "tz": "America/New_York",
  "now": "2026-09-23T11:40:00.000Z",        // the moment the person asks
  "symptom": { "text": "Why did all my plugs and lights turn on overnight?" },
  "home": { "entities": [], "integrations": [], "hub": {}, "cloud": [], "signals": {} },
  "events": [],                             // raw Home Assistant shaped rows, see below
  "ground_truth": { "cause_id": "power_on_default_on", "entity_ids": ["light.kitchen_light", "..."] },
  "human_truth": { "power_switch_check": "yes" },
  "noise": { "jitter_ms": 0, "drop_rate": 0 }
}
```

- **home** is what an adapter would report at `now`: entities in the `HomeAdapter` `Entity` shape,
  integration states, hub status, vendor cloud statuses and per entity signals (LQI, RSSI, battery,
  uptime, power-on behavior). `flaps24h` is left out: count it from the events.
- **events** are raw rows the way Home Assistant keeps them: `state` (history rows; `unavailable` on
  either side is an availability change), `call_service`, `automation_triggered` (with `error` when an
  action failed), `integration`, `registry` and `device_event` (Matter BootReason, a UPS, a power
  meter). Rows link through Home Assistant contexts `{ id, parent_id, user_id }`; `toHouseEvents(rows)`
  resolves them into `HouseEvent`s whose context names the automation, user and service behind every
  change. That is how an agent can say "none of your automations fired".
- **ground_truth** is the cause (one of the ten in the cause library) and the entities it is about.
- **human_truth** is what the person in the room would answer: `confirm_flash` ("I'll flash it twice.
  Did it blink?"), `power_switch_check` ("Is its wall switch on and is it plugged in?"),
  `router_changed` ("Did your Wi-Fi router or its name change recently?"). Unset means they would not
  know.
- **noise** says how much timing jitter and how many dropped rows the logs carry (at most 15%).

Agents only ever see a `ScenarioView`: `id`, `tz`, `now`, `symptom`, `home`, `events`. Title, source,
assumptions, ground truth and human truth stay with the runner. `scenarioHome(view)` turns a view into
a `HomeAdapter`, so an agent built for a live house runs on a scenario unchanged: reads come from the
scenario; writes land on a private overlay with the same physical rules (an unavailable entity
rejects).

Two validators enforce the format: the JSON Schema, and `validateScenario()` (no dependencies, also
checks the time zone and that no event is later than `now`). The test suite runs both over every
incident and many generated scenarios and checks they agree on broken input too.
`checkEvidence(scenario)` checks that a scenario carries the evidence its cause needs; every incident
and every noise free generated scenario passes it.

## The generator

`generateScenario(seed)` builds one broken home from one seed with its own event level simulator,
independent of SimHome and of any agent's model: a random house (3 to 6 rooms, Zigbee, Hue, Matter,
Kasa, Shelly, Tuya and ecobee devices, automations), a storyline for the cause, everyday life around it
(people by voice and app, automations, sensors), distractors (an unrelated blip, a low battery, an old
ghost copy of another device, a Home Assistant restart), correlated failures (a whole bridge, every
Wi-Fi plug, a power restore across integrations) and then log noise.

- **dev**: seeds 1 to 500. **held out**: seeds 10001 to 10200. Tune on dev, report on held out.
- Causes are balanced in blocks of ten seeds, in a shuffled order per block, so the id does not give
  the cause away.
- Same seed, same scenario, byte for byte.

Measured with `npm run stats` on 15 October 2026:

| | dev | held out |
| --- | --- | --- |
| scenarios (per cause) | 500 (50 each) | 200 (20 each) |
| mean drop rate (min, max) | 0.071 (0, 0.149) | 0.075 (0.002, 0.15) |
| mean timing jitter (max) | 635 ms (1497 ms) | 627 ms (1487 ms) |
| mean log rows, entities | 192, 19 | 198, 20 |
| evidence complete without noise | 500 / 500 | 200 / 200 |
| evidence complete with noise | 494 / 500 | 198 / 200 |

All 700 generate in 1.6 to 2.0 s on the build machine (two runs). Where noise removed the evidence, the right answer is "likely" or
"can't tell", which is exactly what the false confirmation metric rewards.

## The incidents

Twenty scenarios in `incidents/`, reconstructed from public reports dated 18 April 2025 to 10 October
2026, covering all ten causes (3 stale duplicate, 3 power-on default, 2 each for name collision, dead
trigger, Wi-Fi network change, account link, vendor cloud and weak radio link, 1 each for hub down and
power lost). Every quote is verbatim from the fetched report text; every file has
`"reconstructed": true` and lists its assumptions: what the report does not say (time zone, brands,
other rooms, times) and, where the report names no cause, which plausible cause the reconstruction
assumes. The people in the reports used the Alexa app, not Home Assistant; the reconstruction expresses
their homes in Home Assistant shaped logs so every agent reads the same format.

## The bench

```ts
const result = await runBench(agent, scenarios, { humanReliability: 0.9, seed: 1 });
```

An agent is `{ name, diagnose(view, askHuman) }` and returns
`{ cause_id, level: 'confirmed' | 'likely' | 'cant_tell', confidence?, probes_used?, disruptive_probes? }`.
`askHuman({ kind })` answers from the scenario's human truth; with probability `1 - humanReliability`
the person gets it wrong, as people do, and `'not sure'` when they would not know.

| Metric | Meaning |
| --- | --- |
| `top1` | right cause and not abstaining, over all scenarios (abstaining earns no credit) |
| `top1_answered` | right cause over the scenarios the agent answered |
| `false_confirmed` | said "confirmed" and was wrong: the number that matters for trust |
| `confirmed_precision` | share of "confirmed" verdicts that were right |
| `abstention_rate` | share answered "can't tell" (agent errors count here too) |
| `probes_used`, `disruptive_probes` | reported by the agent; disruptive defaults to one per flash question |
| `human_questions` | questions the agent asked the person, counted by the runner |
| `latency_ms` | mean, p50, p95, max per scenario |

Results also break down per cause and list every case with the person's answers. The tests check that
an agent that always says "can't tell" and an oracle score exactly what they should.

## How to add an incident

1. Find a dated public report with a concrete failure. Copy a short quote exactly as written.
2. Add a spec to `scripts/incidents.ts`: the devices (entity id, name, integration, signals), the
   timeline in household time (`cmd`, `down`, `up`, `set`, `auto`, `integration`, `registry`, `boot`),
   the ground truth, what the person would see, and every assumption you made.
3. Run `npm run incidents`. It builds `incidents/<id>.json`, validates it, checks its
   evidence and regenerates `src/incidents.ts`; it refuses to write anything if a check fails.
4. Run `npm run check`. A test confirms the JSON files match the specs.

`CONTRIBUTING.md` has the full checklist, including what a good source looks like.

You can also write the JSON by hand: anything that passes `schema/scenario.schema.json` and
`checkEvidence()` is a valid incident.

## How SimHome models a house (and where it simplifies)

- **Push vs polled.** Zigbee2MQTT and Matter report changes at once. Kasa is polled every 30 s, Hue
  every 60 s, ecobee every 180 s, and a polled integration tolerates one missed poll. So a two second
  power blip restarts the Zigbee and Matter devices in the log while the Wi-Fi plugs never notice; a
  Wi-Fi drop shorter than 30 s never shows, and one longer than a minute always does.
- **Boot times.** After power returns, Zigbee bulbs rejoin in 0.3 to 0.5 s (Hue bulbs 0.3 to 0.7 s),
  plugs in 0.8 to 2.4 s. Thread devices attach again to the mesh in 1.0 to 1.15 s, then the Matter
  controller restores their subscriptions one device at a time, 0.33 to 0.355 s each, and each reports
  `BootReason: PowerOnReboot`. A device that rejoins reports itself at once with no context. So a
  house wide restart of 14 devices spans about 3.3 to 3.5 s. These are model choices, not
  measurements of real hardware (`BOOT_MS` in the source).
- **API round trips.** Every write (`callService`, `registryUpdate`, `registryRemove`,
  `reloadIntegration`, `selectOption`) runs at the current virtual time, then moves the clock on by the
  hub's latency (9 to 31 ms, deterministic), whether it worked or not. Reads take no virtual time. So a
  command and its state change share a timestamp, the next command gets a later one, and
  `events({ since })` (inclusive, like Home Assistant's history) taken after a repair does not count the
  repair's own read back.
- **Config entities.** Power-on-behavior selects keep showing their option while their device is
  offline (writing them still needs the device). SimHome does not log availability for them, so restart
  counts in the log are per device.
- **Voice names.** A spoken name reaches the oldest registry entry whose name or alias matches. That is
  why an old copy left by a pairing again answers first.
- **Retention.** The log keeps the newest 1000 rows and at most 150,000 bytes of them (UTF-8 JSON),
  whichever is smaller; in a lived in house the byte budget fills first, at about six days. A demo house
  snapshot is 73,509 bytes at the start and 168,055 bytes after seven simulated days (731 rows). With
  the longest names and aliases allowed on every entity and 1500 maximal service calls, it measured
  249,119 bytes, under the 256 KB (262,144 byte) bound a Durable Object value needs.
- **Input limits.** What callers send is bounded (`INPUT_LIMITS`): at most 32 targets per service call;
  at most 8 extra service data fields, each a string of at most 64 characters, a number, a boolean or a
  list of up to 4 numbers; names and aliases of at most 64 characters with no control characters; at
  most 4 aliases. A call to an entity that does not exist is refused before it is logged.
- **Untrusted ids.** Every lookup by an id that came from outside checks for an own property, so
  `'__proto__'`, `'constructor'` or `'toString'` are unknown ids (`not_found`, `unknown_integration`,
  `unknown_fault`), never a path into `Object.prototype`. Fault options and service data refuse those
  keys outright. `test/hardening.test.ts` checks that `Object.prototype` is unchanged afterwards.
- **Batteries.** A coin cell sensor loses 0.4% a day, at local midnight. The demo battery starts at
  6.8%, so it reads 6% from 15 to 17 October and dies about two weeks later.
- **Flapping window.** F4 takes a `window` option (`'09:00-15:00'`): drops happen only inside it. The
  default is the whole day; the demo house uses 09:00 to 15:00.
- **Time.** Only `advance()` and `advanceTo()` move the clock; days are planned at local midnight from
  the seed and the date, so advancing in one step or many gives the same house.

## Prior art, and what is different

| Project | What it does |
| --- | --- |
| HassTangle | Offline, deterministic analyzer of Home Assistant automation YAML: feedback cycles, opposite writers, dropped triggers, stale or missing entity references; can replay a bounded event trace. |
| Automation Lens | Read only command line explorer of Home Assistant automations: reference graph, possible loops, conflicting actions, missing references, a simplified simulation. |
| Spook | Home Assistant custom integration with extra services and repairs, for example automations that reference entities that no longer exist. |
| device_doctor | Finds dead devices and silently failing integrations in a Home Assistant instance. |

These tools inspect a real configuration or instance and report findings, and they are good at it.
None of them can tell you whether a diagnosis is *right*, because a real house has no ground truth.
homefault is the missing half: behavioural fault injection into a house whose physical truth is known,
scenarios with labelled causes and labelled human answers, real dated incidents, and a benchmark that
counts confident mistakes. You can wrap any of the tools above as a homefault agent and measure them.

## API

| Export | Purpose |
| --- | --- |
| `SimHome.create(opts?)`, `SimHome.fromSnapshot(json)` | Build or restore a twin. Options: `seed`, `tz`, `now`, `faults` (`'demo'`, `'none'` or a list), `historyHours`, `maxRows`, `maxLogBytes`. |
| `home.inject / clear / activeFaults / advance / advanceTo / snapshot / restore` | Sim controls. |
| `rebaseSnapshot(snapshot, newNowMs)` | A copy of a snapshot whose clock reads `newNowMs`, every timestamp moved by the same delta. Pass the snapshot's own local time of day (15:00 for the demo house) to keep wall clock times such as the 3:11 a.m. outage. Against `SimHome.create` at that time it differs only in when seeded events happen and in the ghost lamp's offline date, which a rebase keeps at the same age (`test/rebase.test.ts`). |
| `home.physical(id)`, `home.person(question)`, `home.resolveName(spoken)`, `home.rows()` | Ground truth, the person in the room, voice name resolution, raw rows. |
| `home.powerCut / setWallSwitch / setCircuit / setHubOnline` | Physical controls for demos and tests. |
| `FAULTS`, `FAULT_IDS`, `FAULT_CODES`, `faultId()` | The fault library. |
| `INPUT_LIMITS`, `BOOT_MS`, `DEFAULT_MAX_ROW_BYTES`, `BATTERY_DRAIN_PER_DAY`, `DEMO_FLAP_WINDOW` | The model's constants, so tests and tools can read them instead of copying numbers. |
| `generateScenario(seed, opts?)`, `generateSet(split)`, `SPLITS`, `causeForSeed()` | The generator. |
| `loadIncidents()`, `INCIDENT_IDS` (from `homefault/incidents`) | The incidents. |
| `runBench()`, `simulatedHuman()`, `metricsOf()` | The bench. |
| `scenarioHome(view)`, `toView(scenario)`, `scenarioFromSimHome(home, meta)` | Run agents on scenarios; freeze a SimHome into a scenario. |
| `validateScenario()`, `parseScenario()`, `checkEvidence()`, `toHouseEvents()` | Format, evidence and log helpers. |
| Types: `HomeAdapter`, `Entity`, `HouseEvent`, `Signals`, `Scenario`, `LogRow`, ... | The adapter shape a smart home agent reads a house through. An agent written against it runs on SimHome, on scenarios and, through its own adapter, on a live hub. |

Errors thrown by SimHome carry a stable `code`: `not_found`, `entity_unavailable`, `unknown_service`,
`invalid_option`, `entity_still_provided`, `unknown_integration`, `hub_unreachable`, `bad_request`,
`unknown_fault`, `bad_snapshot`.

## Develop and test

```sh
npm run check       # tsc (src with no Node types, then everything) + vitest
npm run demo        # the demo house as an agent sees it
npm run stats       # the measured numbers quoted above
npm run incidents   # rebuild incidents/*.json from scripts/incidents.ts
npm run ha:onboard  # onboard a fresh Home Assistant started from fixtures/home-assistant/config
npm run ha:inject -- power-cut   # inject a fault into it (see fixtures/home-assistant/README.md)
```


Versions: TypeScript 6.0.3, vitest 5.0.2 (with its peer vite 8.3.1), esbuild 0.28.2 (bundle test),
@types/node 22.20.4, Node 22.18 or later, all pinned exactly. `.npmrc` sets `legacy-peer-deps=true`
because npm 10.9.4 crashed on vitest 5.0.2's optional peer graph; the one required peer (vite) is pinned
instead. One extra dev dependency, ajv 8.20.0 (released 24 April 2026, the newest release at least 14 days old), validates
the JSON Schema against real data in the tests. homefault has no runtime dependencies.

## Used by

- [Fixwright](https://github.com/SamparkBhol/Fixwright), a home doctor add-on for Alexa+. Its demo house is a SimHome, its
  benchmark (HomeTruth) scores its engine and two LLM baselines on homefault's generated scenarios and
  incidents, and its CI runs the full repair flow end to end against a SimHome. It pins homefault `v0.1.0` as a git
  submodule, exactly as described under [Install](#install).

Using homefault in your agent? Open a pull request that adds a line here.

## License

MIT. See `LICENSE`. The short quotes from public reports in `incidents/` and in this README belong to
their authors and are not covered by the MIT licence; see `NOTICE`. Release notes are in `CHANGELOG.md`.
