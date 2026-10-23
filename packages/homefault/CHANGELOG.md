# Changelog

Versions follow semantic versioning. Until 1.0, a minor version may change the scenario format; when it
does, the `format` field (`homefault.scenario/1`) changes with it.

## 0.1.0 (18 October 2026)

First public release.

- SimHome, a deterministic digital twin on virtual time that speaks the `HomeAdapter` shape: six areas,
  each on its own mains circuit, 47 entities in the default demo house, Home Assistant shaped logs with
  contexts, signals and integration states, and `snapshot()` / `restore()` as plain JSON.
- Ten faults (F1 to F10), each tied to a cause, the checkup finding it should raise, what a person in the
  room would see, and the dated public report it was modelled on.
- The scenario format `homefault.scenario/1` with a JSON Schema (2020-12) and a dependency free validator.
- An event level generator with a dev split (seeds 1 to 500) and a held out split (seeds 10001 to 10200).
- Twenty incidents reconstructed from dated public reports, each with its assumptions written down.
- `runBench()` with top1, false confirmations, confirmed precision, abstention, probes, questions asked
  and latency, and a simulated person in the room with a reliability setting.
- Home Assistant 2026.9.4 fixtures: a simulated hallway circuit, headless onboarding and a fault injector.
- `NOTICE` for the short quotes from public reports.
- CI on Node 22. `npm run check` passes with 13 test files and 359 tests.
