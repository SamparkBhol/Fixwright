# homefault: what the tests prove

Run `npm run check` (tsc on `src` with no Node types, tsc on everything, then vitest).
On 18 October 2026, for the v0.1.0 tag: 13 test files and 359 tests, all passing.

## SimHome

- [x] Implements the `HomeAdapter` shape declared in `src/types.ts`. Projects that declare the same shape
      in their own code can check assignability at compile time; Fixwright does this in its own test
      suite, outside this repository.
- [x] Reads: sorted entities, null for unknown ids, events filtered by window and entity with seq 0,
      contexts that name the automation or user, per transport signals (LQI, RSSI, battery, Matter
      uptime, power-on behavior, flaps in 24 h), integration states, hub status, cloud status
      (`test/simhome.test.ts`).
- [x] Physical reality: an unavailable entity rejects (`entity_unavailable`), a missing one is
      `not_found`, a working lamp lights, a flash blinks it without a state change, the person in the
      room sees the blink; switching off the strip cuts every outlet, switching one outlet does not.
- [x] Real effects: registry rename (and `name: null` restore), aliases change voice resolution,
      disable removes the entity from the state machine, remove retires old copies but refuses entities
      still provided by their integration, reload restarts a hung coordinator but not an expired account
      link (or a hard failure), selectOption changes power-on behavior and rejects bad options and
      offline devices.
- [x] Wall switches, circuits and the hub: a wall switch cuts a lamp and the person says so; a circuit
      cut takes one area offline while the hub on its UPS keeps logging; an unreachable hub fails every
      adapter call except `hubStatus` and `cloudStatus`.
- [x] Virtual time moves on `advance` / `advanceTo`, and by one API round trip (9 to 31 ms) per write,
      whether the write works or not; reads take no time; a command and its state change share a
      timestamp and the next command gets a later one; the same calls give the same times
      (`test/hardening.test.ts`). Advancing in one step or many gives the same house
      (`test/snapshot-determinism.test.ts`).

## Snapshot and determinism

- [x] `snapshot()` round trips through JSON byte for byte, via `fromSnapshot` and `restore`.
- [x] A restored house continues exactly like the original (same snapshot after the same actions).
- [x] Under 256 KB at the start and after three simulated weeks, when the 150,000 byte log budget
      (not the 1000 row cap) is what fills up; a small row cap still applies on its own.
- [x] Under 256 KB in the worst case callers can cause: the longest names and aliases allowed (in
      three byte characters) on every entity plus 1500 calls with maximal service data
      (`test/hardening.test.ts`). The running byte count equals the serialized rows exactly; a smaller
      `maxLogBytes` keeps the newest rows; an older snapshot without the count is accepted and counted.
- [x] Same seed, same events; different seeds, different days with the same demo facts; the generator
      gives the same scenario for the same seed.
- [x] `rebaseSnapshot` moves every timestamp by one delta and nothing else, leaves its input alone, round
      trips, keeps local wall clock times for whole day deltas, continues like the original until the
      next local midnight and keeps planning days for any delta. Against `SimHome.create` at the same
      local time on a later day (seeds 1 and 2, 1, 7 and 30 days, across the November DST change) every
      count, state, row and pending event matches; only the times of seeded events and the ghost lamp's
      offline date differ (`test/rebase.test.ts`).

## Faults

- [x] Ten faults F1 to F10 with ids, codes, causes from the library, descriptions, and the source urls and
      dates each fault was modelled on (F1, F2, F9, F10); F5 has no matching dated report and says so
      (`test/faults.test.ts`).
- [x] Each fault, injected into a healthy house and read through the adapter, produces the evidence its
      cause needs and nothing contradictory (`checkEvidence` on the frozen twin), and validates as a
      scenario.
- [x] Each fault clears back to a healthy house; injecting an active fault again changes nothing.
- [x] Fault specifics: F2 at runtime restarts 14 devices and runs the clock 6 s through the outage; F4
      keeps flapping on later days until cleared; F5 drains 0.4% a day, keeps the sensor powered while the
      reading shows 0%, and takes it offline once it is empty; F9 makes
      the grow light automation fail at both daily runs; F10 leaves the aquarium filter running.

## Default demo house, for seeds 1, 2, 3, 7, 42 and 1234

- [x] Starts at 2026-10-15 15:00 America/Los_Angeles with F1 to F5 active, six areas, six integrations.
- [x] F1: two "Hallway Lamp" entities; the old copy is restored and offline since 3 October and is what
      the spoken name reaches.
- [x] F2: 14 unavailable rows at 03:11:58; 14 back `on` starting 03:12:00, all within 4 s of the power;
      no context; no automation run or service call in the hour; one restart cluster; 8 Matter
      `PowerOnReboot` events; the 14 are exactly the devices whose power-on behavior is `on`, across
      zigbee2mqtt and matter.
- [x] F2 restart span, measured the way the engine measures it (each device's first sign of coming back,
      first device to last): 14 devices, over 3 s and at most 4 s, so it rounds up to "four seconds";
      for the six seeds and for seeds 1 to 60.
- [x] F3: a Hue room and a Zigbee bulb both online as "Living Room Light".
- [x] F4: kitchen plug 9 drops in 24 h and 9 since local midnight, RSSI -82.
- [x] F5: hall motion battery 6%.
- [x] Aquarium filter on living room strip outlet 2 (on), reading lamp on outlet 1 (on at 15:00);
      two strips with three child outlets each.
- [x] Golden path: flash the online copy and the person says it blinked, the old copy rejects. The
      engine's own calls at 15:00 (flash on and off twice, rename, retire the old copy, read back on and
      off) each get their own timestamp before the repair ends, and the next morning the lamp has exactly
      9 commands since the repair, each answered within 10 s, with nothing unavailable overnight. After
      setting power-on behavior to `previous`, the next outage turns nothing on.
- [x] In the order a demo runs (diagnose, repair, checkup), after the jump to 07:00 on 16 October: kitchen plug still 9 drops in 24 h (also at
      20:00, 23:59, 03:30 and 08:55), RSSI -82, battery 6%, two Living Room Lights, reading lamp on. The
      3 a.m. hour of 16 October is quiet, which the README documents.
- [x] Sweeps outside the tests, with scratch scripts that were deleted afterwards: for seeds 1 to 500,
      every demo number above holds at 15:00 and at 07:00 the next day, and the restart span runs from
      3.288 to 3.519 s. Through Fixwright's diagnosis engine, in its own repository (diagnose, answer,
      plan, apply, morning check, explain, checkup, protected strip guard), seeds 1 to 500 in that order
      all said "answered all 9
      commands overnight", "Fourteen devices restarted within four seconds" (with the 15 October window),
      "battery is at 6%", "9 times in the last day" and "I'll turn off the lamp on it instead"; seeds 1
      to 200 with steps 5 to 7 before the jump also said "9 times today".

## Hardening (`test/hardening.test.ts`)

- [x] `'__proto__'`, `'constructor'`, `'prototype'`, `'toString'`, `'hasOwnProperty'` and `'valueOf'`
      are unknown ids everywhere: reads return null or `not_found`, writes reject before logging
      anything (`not_found`, `unknown_integration`, `unknown_service`), god view controls and fault
      options reject them, `faultId` says `unknown_fault`. `Object.prototype` has the same own
      properties afterwards and `{}` has no `state`, `reason`, `name`, `restored` or `status`.
- [x] A JSON body with an own `__proto__` key is refused (service data, fault options) or ignored
      (registry patch); the F6 vendor cannot be `__proto__`.
- [x] The scenario adapter returns null or `not_found` for those keys; the bench records an agent that
      asks an unknown question kind as an error, not a guess.
- [x] Oversized, nested or too many service data fields, too many targets, oversized options, long or
      empty names, control characters and too many aliases are refused and never logged; real service
      data (brightness, colour, transition, flash, temperature) is accepted and logged as sent.

## Scenario format

- [x] `schema/scenario.schema.json` (`$id` `urn:homefault:schema:scenario:1`) compiles with ajv 8.20.0
      in strict mode (2020-12) and accepts all
      20 incidents, a SimHome twin and generated dev and held out scenarios (`test/schema.test.ts`).
- [x] The schema and the dependency free `validateScenario` reject the same 16 kinds of broken input
      and accept the same valid input.

## Generator

- [x] Dev seeds 1 to 500 and held out seeds 10001 to 10200, disjoint, 700 unique ids
      (`test/generator.test.ts`).
- [x] Exactly 50 (dev) and 20 (held out) scenarios per cause; every block of ten seeds holds each cause
      once; block orders differ, so ids do not reveal causes.
- [x] Drop rate always within 0 to 15% (mean between 6% and 9%), the measured share of dropped rows
      matches the declared rates within 1 point, jitter at most 1.5 s, no row after `now`; noise only
      touches the logs.
- [x] All 700 validate. Without noise, all 700 carry the evidence their cause needs; with noise fewer
      than 5% lose it.
- [x] Distractors (blips, low batteries, old ghosts, HA restarts) each appear in over 30 scenarios;
      correlated failures (whole bridge down, power restore across integrations) are present.

## Incidents

- [x] Exactly 20 files, all loaded by `loadIncidents()`, covering all ten causes (`test/incidents.test.ts`).
- [x] Each: kind incident, `reconstructed: true`, at least three assumptions, a dated Reddit or Verge
      url, a quote of 20 to 400 characters, a publisher, no noise, dated before 15 October 2026.
- [x] Each carries the evidence its ground truth needs and nothing contradictory.
- [x] The files match the authoring specs in `scripts/incidents.ts` exactly.
- [x] No email addresses, user handles or phone numbers.
- [x] Checked once outside the test suite (the source text is not shipped): all 20 quotes appear verbatim
      in the fetched report text and all 20 dates match the reports' publication dates.

## Bench

- [x] An always-"can't tell" agent: top-1 0, abstention 1, no confirmations, no false confirmations,
      `top1_answered` and `confirmed_precision` null (`test/bench.test.ts`).
- [x] An oracle: top-1 1, all 70 confirmed, 0 false confirmations, precision 1, probes counted.
- [x] A confidently wrong agent: every wrong confirmation counted; "likely" earns credit but is never a
      false confirmation; an agent that throws is an abstention with the error kept.
- [x] Agents see only `id, tz, now, symptom, home, events`.
- [x] Human questions and implied flashes are counted; answers are truthful at reliability 1 and match
      the configured reliability within 3 points over 4000 questions at 0.9, 0.7 and 0.5; "not sure"
      when the scenario does not know.
- [x] Runs are deterministic for a seed; a rule based agent runs on scenarios through `scenarioHome`.

## Purity

- [x] No Node built in modules, `Date.now()`, `new Date()`, `Math.random()`, crypto, fetch, timers, classes or
      `@fixwright` imports in `src`; the only runtime global is `performance.now` as the default bench
      timer; no runtime dependencies (`test/purity.test.ts`).
- [x] `src/index.ts` and `src/incidents.ts` bundle with esbuild for a neutral platform with workerd
      conditions, with no `node:` inputs.
- [x] Household time converts correctly in summer, winter, across the spring forward gap and the
      fall back hour (`test/logrows-time.test.ts`).

## Home Assistant fixtures

- [x] `fixtures/home-assistant/ha-client.ts` (the dependency free client behind `onboard.ts` and
      `inject.ts`) sends the bearer token, lower cases entity ids, refuses service names that are not
      slugs, turns HTTP errors into thrown errors, authenticates the websocket, handles frames that Home
      Assistant batches into one JSON array, delivers subscribed events and unsubscribes, rejects a wrong
      token, reads a `select_option` back before returning, refuses unknown options and non-select
      entities, and reloads a YAML integration through its reload service (`test/ha-fixture-client.test.ts`,
      fake fetch and fake websocket).
- [ ] The fault injections themselves run against a real Home Assistant 2026.9.4. They were exercised by
      Fixwright's Home Assistant adapter tests and CI with the same config under Fixwright's names (the
      bridge integration was `fixwright_bridge` there). After the rename to `homefault_bridge`, a static
      check confirmed that the folder, the manifest domain, `const.py`, the `configuration.yaml` keys and
      `inject.ts` agree; the renamed config has not been booted on a live Home Assistant
      yet, and this repository's CI does not start Home Assistant.
