# Contributing to homefault

Thanks for helping. The most useful contribution is a new incident: a real, dated report of a smart home
failure, rebuilt as a scenario that any agent can be scored on. Bug reports, new faults for SimHome and
new generator causes are welcome too.

## Ground rules

- Never invent facts. A quote is copied exactly from its source. Anything the source does not say is an
  assumption and is written down as one.
- Keep quotes short, one or two sentences, always next to the link. They stay their authors' words and
  are not covered by the MIT licence (`NOTICE`). Never paste a whole post or review into the repository.
- No personal data: no names, usernames, emails, addresses or tokens in scenarios, fixtures or tests.
  Rename devices if the report used a person's name for one.
- Pure TypeScript in `src/`: no Node built in modules, no `Date.now()` or `Math.random()` in logic (use the
  injected clock and seeded rng), no top level I/O. `test/purity.test.ts` checks this.
- Exact version pins, newest release at least 14 days old when you add a dependency. homefault has no
  runtime dependencies and should keep it that way.
- `npm run check` must pass before a pull request.

## Set up

```sh
npm ci
npm run check
```

Node 22.18 or later runs the `.ts` scripts directly.

## Add an incident

1. **Find a source.** A public report with a date and a concrete failure: a forum post, an issue, a
   review, an article. It needs enough detail to tell which cause it was, or to say plainly that the
   report does not say and which cause you assume. Copy a short quote exactly as written, and the URL.
2. **Pick the cause.** One of the ten in `src/types.ts` (`stale_duplicate`, `device_power_lost`,
   `radio_link_weak`, `hub_down`, `vendor_cloud_outage`, `account_link_expired`, `power_on_default_on`,
   `name_collision`, `dead_trigger`, `wifi_network_changed`). If none fits, open an issue first: a new
   cause touches the generator, the bench and every agent that reads the scenarios.
3. **Write the spec** in `scripts/incidents.ts`, next to the existing twenty (the `IncidentSpec` type in
   `scripts/incident-kit.ts` has every field):
   - `n` and `slug`: the next free number and a short slug; the file becomes `incidents/inc-NN-slug.json`.
   - `title`, and `source`: the URL, the date (YYYY-MM-DD), the publisher and the quote.
   - `tz` and `now`: the household time zone and the moment the person asks for help.
   - `symptom`: what the person would say to their assistant.
   - `devices`, and where needed `automations`, `integrations`, `cloud` and `removed`: entity ids, spoken
     names, integrations, transports, and signals (link quality, RSSI, battery, power-on behaviour).
   - `steps`: the timeline in household time, with the step kinds the kit understands (`cmd`, `down`,
     `up`, `set`, `auto`, `integration`, `registry`, `boot`).
   - `truth`: the cause id and the entity ids involved.
   - `human`: what a person in the room would see if asked ("did it blink?", "is the wall switch on?",
     "did your router change?").
   - `assumptions`: every detail the report does not state (time zone, brands, other rooms, times).
4. **Build it.** `npm run incidents` writes `incidents/<id>.json`, validates it against
   `schema/scenario.schema.json`, checks that every piece of ground truth evidence is in the logs, and
   regenerates `src/incidents.ts`. It writes nothing if any check fails.
5. **Check it.** `npm run check`. A test confirms each JSON file matches its spec, and the bench tests
   run the always abstain agent and the oracle over every incident.
6. **Open a pull request** with the source link, the quote, and one line on why you chose the cause.

You can also write a scenario JSON by hand. Anything that passes `validateScenario()` and
`checkEvidence()` is a valid incident, but specs in `scripts/incidents.ts` are easier to review.

## Add or change a fault in SimHome

Faults live in `src/faults.ts` and `src/sim/`. Each one needs: an id, the cause it maps to, the checkup
finding it should raise, what a person in the room would see, and the dated public report it was modelled
on. Physical truth (circuits, switches, radio links) stays separate from what the hub observes; a fault
lives in the gap between the two. Add a test in `test/faults.test.ts` that injects it, advances time and
reads the logs back.

## Change the Home Assistant fixtures

`fixtures/home-assistant/config` is a real Home Assistant 2026.9.4 config. Test a change against a real
instance (see `fixtures/home-assistant/README.md`) and run every injection in `inject.ts` once. Keep
everything simulated: no integration that reaches a device or a cloud.

## Report a bug

Include the seed, the fault ids, the homefault version and the smallest code that shows the problem.
SimHome is deterministic, so a seed and a sequence of calls reproduce it exactly.

## Cut a release

1. Add the changes under a new version in `CHANGELOG.md`, and set the same version in `package.json`.
2. `npm run check` on a clean checkout.
3. Commit, then tag: `git tag -a v0.2.0 -m "homefault 0.2.0"`, and push the tag. Projects that use
   homefault pin a tag, so never move one that has been pushed.

## License

By contributing you agree that your contribution is licensed under the MIT License in `LICENSE`.
