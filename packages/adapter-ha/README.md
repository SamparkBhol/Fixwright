# @fixwright/adapter-ha

The Home Assistant side of Fixwright: `HaAdapter` implements the protocol's `HomeAdapter`
against a real Home Assistant 2026.9.4, using only `fetch`, the standard `WebSocket` and
`addEventListener`. The same source runs in Cloudflare workerd (proven with wrangler dev), Node 22 and
the browser.

Registry writes, select changes and config entry reloads are read back before they return. Service
calls return what Home Assistant reports as changed and leave the read back to the caller (the engine's
executor reads every repair step back). Every request has a deadline, reads retry with jitter, and
failures say whether the hub is unreachable, the token is wrong, or the thing does not exist. Before
any service call is sent, the adapter works out everything the call could reach, reading entity ids and
service names the way Home Assistant does, and refuses the call if that includes a lock, alarm, camera,
siren or garage door, or if it cannot see what the call reaches (see Safety guard).

## API

```ts
import { createHaAdapter, toProtocolError } from '@fixwright/adapter-ha';

const ha = createHaAdapter({ baseUrl: 'https://home.example', token: LONG_LIVED_TOKEN });
const lamp = await ha.getEntity('light.hallway_lamp');
ha.close(); // closes the websocket; the adapter reconnects if used again
```

`createHaAdapter(config: HaAdapterConfig): HaAdapter` (throws synchronously on a bad URL or empty token)

| Config | Default | Meaning |
| --- | --- | --- |
| `baseUrl`, `token` | required | Home Assistant origin (a trailing `/api` is fine) and an admin long lived token |
| `timeoutMs` | 10000 | deadline per REST attempt and per websocket command |
| `retry` | `{ retries: 2, baseMs: 250, maxMs: 4000 }` | idempotent reads (and handshakes that sent nothing); equal jitter backoff; honours Retry-After |
| `readBackTimeoutMs`, `readBackPollMs` | 5000, 50 | how long a write may take to show up |
| `registryCacheMs` | 30000 | device, area and manifest registries, the entity index `signals()` uses, and automation references |
| `denyDomains` | lock, alarm_control_panel, camera, siren | entity domains the guard refuses, through every target shape it resolves (see Safety guard) |
| `allowGarageCovers` | false | covers with device class garage, gate or door are refused unless true |
| `unsafeNames` | the engine's words (lock, garage door, gate, alarm, camera, doorbell, siren, ...) | entities named like this are refused too; `null` turns it off |
| `allowServices` | none | `'domain.service'` names let through although the guard cannot see all they reach (an integration's own service, a call without a target); the entities they name are still checked |
| `authHoldMs` | 30000 | after Home Assistant rejects the token, calls fail without being sent for this long |
| `transportHints` | none | `Transport` by entity id or integration, overriding inference |
| `numericChanges` | `'drop'` | whether `events()` keeps number to number sensor changes (see Events) |
| `clock`, `rng`, `sleep`, `fetch`, `connector` | system | injectable for tests and Workers |

| Method | Home Assistant calls | Read back / notes |
| --- | --- | --- |
| `listEntities()` | REST states; ws `config/entity_registry/list` + `get_entries` (aliases), device and area registries, `manifest/list`, `search/related` per automation | registry entries without a state come back `registryOnly`; automations carry `attributes.references` |
| `getEntity(id)` | REST state + ws `config/entity_registry/get_entries` (+ `search/related` for an automation) | `null` when neither exists |
| `callService(d, s, data)` | guard reads, then REST `POST /api/services/d/s` (domain and service lower cased first) | returns the states Home Assistant changed during the call, mapped; never retried; no read back of its own |
| `events({ since, until?, entityIds? })` | ws `logbook/get_events` + `history/history_during_period`, states for battery device classes | joined on exact timestamps, see Events |
| `signals(id)` | REST state of the entity and of its device's other entities, cached entity index, 24 h history | see Signals |
| `integrations()` | REST config entries + ws `config_entries/flow/progress` | reauth flow or auth reason gives `setup_error`, reason `auth: ...` |
| `hubStatus()` | REST `/api/config`, single attempt | `reachable` means answering and core `RUNNING`; auth failure throws |
| `cloudStatus(vendor)` | states, config entries, manifests, registry rows of cloud connectivity sensors only | `unknown` with source "not available from Home Assistant" unless a cloud connectivity sensor or a retrying cloud integration says more |
| `registryUpdate(id, { name, aliases, disabled })` | ws `config/entity_registry/update` | registry read again until it matches; then waits for the state's friendly name (or, when disabling, for the state to leave) |
| `registryRemove(id)` | ws `config/entity_registry/remove` | state 404 and registry entry gone |
| `reloadIntegration(domain or entry id)` | REST config entry reload, else `<domain>.reload` service | config entries: waits until `loaded`, any other end state (for example `setup_retry`) throws `readback`; `require_restart` throws `unsupported`. The YAML reload service is acknowledged by Home Assistant once the reload finished; there is no entry state to read back |
| `selectOption(id, option)` | REST `select.select_option` (or `input_select`) | the guard's entity rules first (a lock's mode select is refused), option validated; state read again until it equals the option |
| `now()` | injected clock | |

Errors are `HaError` (`isHaError`): `kind` is one of `unreachable`, `timeout`, `auth`, `not_found`,
`bad_request`, `server`, `protocol`, `command_failed`, `readback`, `refused`, `unsupported`, with
`status` (HTTP), `code` (websocket), `retryable` and, for `refused`, `refusal` (`unsafe_device` or
`unverified`). `toProtocolError(err)` turns any of them into the protocol's `ProtocolError`:
unreachable and timeout become `hub_unreachable`; auth gets its own spoken line; a refusal is
`unsafe_device` ("I don't change locks, garage doors, alarms or cameras.", or for `unverified` "I only
change devices I can check first, so I left that one alone."); `unsupported` is `no_fix` ("That
integration only reloads when Home Assistant restarts, and I leave restarts to you."). Websocket
`home_assistant_error` (a handler that refused on purpose) is not retried; only `unknown_error` is.
After a rejected token, calls fail with kind `auth` and the message "... was not sent" until
`authHoldMs` has passed (see Websocket and REST login).

Lower layers are exported too: `createRest`, `connectSocket` (with `ping`, `subscribeEvents`),
`createAuthGate`, the guard (`serviceTarget`, `normalizeEntityId`, `isValidEntityId`, `resolveIndirect`,
`serviceRefusal`, `reachRefusal`, `entityRefusal`, `forwardedTo`, `ENTITY_SERVICE_DOMAINS`), pure mapping
helpers (`toEntity`, `mergeEvents`, `historyTransitions`, `uptimeResets`, `signalsFrom`,
`inferTransport`, `toIntegrationStatus`, `cloudStatusFrom`, `contextFromRow`, `causeOf`,
`expectedFriendlyName`) and the Home Assistant wire types.

### Safety guard

The engine never plans anything on locks, garage doors, alarms, cameras or security
systems; the adapter checks again before it sends any service call (`src/guard.ts`). Home Assistant
lets a call reach entities in many ways, so the guard resolves them the way `helpers/target.py` and
`helpers/config_validation.py` do in 2026.9.4, but wider (ids match in any case, hidden and diagnostic
entities are never skipped, child devices count):

- **Names as Home Assistant reads them.** Home Assistant lower cases the domain and service
  (`ServiceRegistry.async_call`) and every entity id (`cv.entity_id`), so `LOCK.FRONT_DOOR` is
  `lock.front_door`. The guard does the same before any check, matches `all` and `none` in any case,
  and refuses as `unverified` a value that is still not a valid entity id (Home Assistant would reject
  the call anyway; the guard does not guess).
- **Explicit ids** (string, comma list or array, at the top level or under `target`), the entity ids
  a `scene.apply` or `scene.create` names as data, and `entity_id: all` (every entity of the service's
  domain, every entity at all for the generic `homeassistant` domain).
- **`area_id`, `device_id` (with child devices), `floor_id` and `label_id`**, through fresh reads of
  the entity, device and area registries.
- **Members** of groups, cover and light groups and scenes (their `entity_id` attribute), recursively.

Each entity reached is refused (`refusal: 'unsafe_device'`) when its domain is denied, when it is a
cover with device class garage, gate or door, or when its friendly name or entity id uses the engine's
unsafe words. A call is refused as `unverified` when the adapter cannot see what it would do:

- an integration's own service (any domain that is not an entity platform or core helper, such as
  `mqtt.publish`, `zha.issue_zigbee_cluster_command`, `zwave_js.set_value`, `knx.send`, ESPHome actions,
  `hassio`, `shell_command`), because it can address a device directly whatever entity it names;
- a call that reaches no entity at all (`conversation.process`, `device_tracker.see`, a legacy notify
  service, a cover call with no target), except `reload` services of entity domains;
- scripts (anything but `turn_off` and `reload`, also when `homeassistant.turn_on` reaches one),
  `automation.trigger`, `homeassistant.stop` and `restart`, `remote.send_command` and `learn_command`
  (raw infrared or radio codes), a scene from an integration that does not list its members, and a
  `device_id` the registry does not know (Home Assistant may split it into devices the adapter cannot
  see).

`allowServices` lets named services past the `unverified` rules; the entities they name are still
checked, and a denied domain stays denied. When entities found together fail for both reasons, the
unsafe device is the reason given, because it is the clearer thing to say. Explicit ids cost one state
read each (up to 12, then one read of the state machine); area, device, floor and label targets add
three registry reads.

`selectOption` applies the entity rules to the select it changes. `reloadIntegration` sends only config
entry reloads and `<domain>.reload` services, which recreate entities and never operate a device; it
does not go through the guard.

Limits, all of the kind "the guard checks what a call reaches, not what reacts to it":

- a plain switch or button wired to a garage opener, that Home Assistant does not mark as a cover and
  that is not named like one, is not recognised (the engine's own name rules are the same words);
- an entity whose integration runs user written actions (a template switch, light or cover) is checked
  by its own domain, class and name, not by what its actions do; the fixture's own simulated lights are
  template lights;
- automations that react to a change the call makes (a light turning on, a helper flipping) run with
  Home Assistant's own permissions; the guard does not follow them, since that would refuse every light
  an evening lock routine watches.

### Events

History gives every state change with the state before it; the logbook gives who caused it. A logbook
row's `when` equals the state's `last_updated` to the microsecond, so each change is joined with the row
for the same entity, state and time. `context` maps the logbook's context fields:
`automationId` (the change ran inside an automation, even if a person triggered it), `service`
(`domain.service` of the call that started it), `userId`, `eventType`. `causeOf(context)` reads it as
`automation`, `user`, `service` or `none`. Sensors the logbook leaves out still appear from history.
Automation runs become `automation_run` events, scripts `service_call`, Home Assistant start and stop
`integration`. `kind` is `availability` for changes into or out of `unavailable`, else `state`.

Numeric sensors: with `numericChanges: 'drop'` (default) number to number changes (power readings,
temperatures) are left out, except battery sensors (`*_battery`, `*_battery_level`, or device class
`battery` whatever the id, kept so a fast drain is visible) and uptime resets. An uptime sensor
(`*_uptime`, `*_last_restart`, `*_last_boot`, `*_boot_time`) whose number goes down, also across an
unavailable gap, or whose boot timestamp moves forward by more than a minute, is a device restart: that
event carries `data.uptime_reset: true`, the field the engine's power restore detector reads (it
accepts uptime resets as evidence). Uptime ticks themselves are dropped. `'keep'` keeps every change
and still marks resets.

Two event conventions the engine reads cannot come from Home Assistant: past registry changes (the
logbook does not record `entity_registry_updated`, and no other API lists past events), and `power`
kind events (no standard entity reports a Matter boot reason). Device restarts arrive as uptime resets
instead, which the engine's power restore detector reads; registry changes Fixwright makes itself are
recorded by the engine's executor as `repair` events.

### Automation references

Automations carry `attributes.references`: every entity the automation triggers on, checks or acts on,
sorted, from Home Assistant's `search/related` (the `entity` list, which also unwraps the groups,
scenes and scripts the automation uses). It lists ids that no longer exist too, which is exactly the
evidence the engine's `dead_trigger` finding needs; the fixture's grow light
schedule refers to a plug that was removed. One websocket command per automation, cached for
`registryCacheMs`. A hub without the `search` integration (it is part of `default_config`) gives no
references and no error.

### Signals

From the entity's own attributes first (Zigbee2MQTT `linkquality`, `last_seen`, `battery`,
`power_on_behavior`; Wi-Fi `rssi`), then from related entities: the same device's sensors and selects,
or without a device, entities named `<object_id>_<signal>` the way Zigbee2MQTT names them. The power on
select is matched by suffix or translation key and its value normalized (Zigbee2MQTT, ZHA
`PreviousValue`, Matter). `flaps24h` counts transitions into `unavailable` in the last 24 h of history.
Out of range values are dropped, never clamped.

Reads are scoped, because the engine's checkup calls `signals()` for every device at once: the entity's
state, a cached index of the entity registry (one `config/entity_registry/list` per `registryCacheMs`,
shared by concurrent calls and cleared by the adapter's own registry writes), the states of the
device's other entities (one read each, or one state machine read above 12), and the entity's 24 h
history. Only an entity without a device needs one read of the whole state machine, for the
name based lookup.

### Names

`expectedFriendlyName` predicts the friendly name Home Assistant 2026.9.4 shows: a registry name
replaces the whole name; otherwise device name plus entity name, for `has_entity_name` entities and
legacy ones alike, because 2026.9 strips a leading device name from a legacy entity's name and the
registry API already sends that stripped form (`original_name_unprefixed`). The live suite checks the
prediction for every entity of the fixture with a state (it asserts more than 100, at least two of them
legacy entities on a device), and a unit test replays recorded legacy entries.

### Transport

Best evidence first: `transportHints`, a Zigbee radio connection, a Zigbee2MQTT device, known
integrations (zha, hue, deconz: zigbee; matter, thread: thread; tplink, shelly, esphome: wifi;
ecobee, nest, tuya: cloud), what the entity reports (`linkquality` means Zigbee, `rssi` Wi-Fi), then the
integration manifest (`cloud_*` iot class: cloud; helper, service or calculated: virtual). Unknown local
devices become `wifi`, since the protocol has no wired or Bluetooth value.

### Websocket and REST login

One shared websocket per adapter, opened lazily. The handshake is single flight for success and
failure: every call that arrives while a handshake runs gets its socket or its error. A handshake that
could not connect sent nothing, so it is retried with backoff even for a write. A command that times
out on a socket that does not answer a ping drops that socket.

Home Assistant counts every rejected token (HTTP 401 or 403, websocket `auth_invalid`) toward its
`ip_ban` login threshold, and the engine's checkup starts many reads at once. So REST requests and the
websocket login share one auth gate (`src/auth.ts`): until the token has been accepted once, one
request goes out and the others wait for its answer (once; after a network failure they go, so a dead
hub does not queue every call behind the last timeout); after a rejection, every call fails at once
for `authHoldMs` without sending anything. Live, five calls started together with a wrong token, plus a
sixth inside the hold, cost one rejected login in Home Assistant's log (see Measured).

### In a Worker

Create the adapter inside the request (or the Durable Object) that uses it: a Worker cannot use a
websocket opened by another request. `new WebSocket(url)` works in workerd; the fetch Upgrade path works
too (`connector`, see `worker/smoke.ts`). A Worker cannot reach `127.0.0.1` or a home LAN, so real
homes need a public Home Assistant URL (Nabu Casa or a tunnel).

## Home Assistant fixture

`fixtures/home-assistant/config` is a simulated hallway circuit, built so the F1 and F2 shapes and a
hub failure are real Home Assistant behaviour, not forced states. Everything in it is simulated hardware.

- **Mains and breaker.** `input_boolean.hallway_mains` is the breaker. The devices see power through
  `binary_sensor.hallway_mains_power`, a trigger based template sampled once a second. That gives each
  power change a fresh context with no user, service or automation, exactly like real bulbs dropping off
  and coming back (flipping the devices straight from the breaker would give every restore the
  breaker's user context). Cost: 0 to 1 s between breaker and devices.
- **Six devices on the circuit** (hallway lamp, porch, landing, stair and entry lights, hallway smart
  plug), each with a Zigbee2MQTT shaped `select.<device>_power_on_behavior` backed by its own device
  memory, default `on`. A light group (`light.hallway_lights`) is a second integration on the circuit.
- **Simulated firmware** (`custom_templates/bulb_firmware.jinja`): a device follows its last command
  while powered and applies its power on behavior when power returns after that command; changing the
  behavior later only matters at the next power cut. Doing this in an automation would stamp
  every restore with automation context; real bulbs report the restore with none, so the firmware
  lives in the template.
- **Plug uptime** `sensor.hallway_smart_plug_uptime`: seconds since the plug last got power, sampled
  once a second; after a power cut it starts again from zero (the uptime reset case).
- **Radio link**: `input_boolean.porch_light_link` off makes the porch light unavailable for real.
- **Dead old pairing** `light.hallway_lamp_old_pairing`, also named "Hallway Lamp": the F1 duplicate.
- **Restore log automation** notes each restore and never switches a device; it is the automation
  context case in the same power cut.
- **Grow light schedule** (F9 shape): an automation that still refers to `switch.grow_light_plug`, a
  plug that no longer exists. Its `attributes.references` is the dead trigger evidence.
- **Evening routine** script (turns the porch light on): the guard must never start it, also not
  through `homeassistant.turn_on`; the live test checks the porch light did not move.
- `search:` is loaded, for automation references.
- **Simulated bridge** (`custom_components/fixwright_bridge`, a small custom integration with a real
  config entry, created from `fixwright_bridge:` in configuration.yaml): two Zigbee lights behind a
  "Hallway Bridge" device. `input_boolean.fixwright_bridge_link` off makes the integration itself mark
  its lights unavailable, and they stay so after the link returns until the config entry is reloaded,
  like a bridge integration with a dead connection. Reloaded while the link is down, the entry goes to
  `setup_retry` (ConfigEntryNotReady) and its lights are restored ghosts: the hub_down shape. Its two
  diagnostic sensors are legacy named entities on a device, for the name prediction.
- Signal attributes: linkquality on the lights, rssi on the plug, a hall motion sensor with a separate
  `sensor.hall_motion_battery`.

`fixtures/home-assistant/inject.ts` (importable and a CLI):
`setup` (Hallway area, all devices off by command), `unavailable [entity]` (radio dropout for the porch
light, forced state for any other entity), `available [entity]`, `ghost` / `unghost` (move the old
pairing's YAML aside and reload templates: registry kept, `restored: true`; needs `HA_CONFIG_DIR`),
`duplicate <entity> <name>`, `power-cut [--at <ISO>] [--hold <ms>]` (returns Home Assistant's own
timestamps), `power-on <option> [entity...]`, `bridge-down` / `bridge-up`. A template reload (ghost,
unghost) briefly recreates every template entity.

**Home Assistant 2026.9 gotcha.** On a fresh config, 2026.9 migrates the YAML `http:` block into a
pending trial config and, unless it is promoted within 5 minutes, reverts to the defaults (port 8123)
and restarts. Without a supervisor that restart ends the process. `scripts/onboard.ts` therefore calls
`http/config/promote`; a fixture instance then ran 354 s past launch with no revert (15 Oct 2026).
The Fixwright server's own Home Assistant demo run needs the same step.

## Testing

```
npm run check              # tsc (Node) + tsc (Workers types) + unit tests; live tests skip
npm run test:integration   # scripts/integration.sh: start HA, run tests tagged integration, stop HA
npm run ha:start / ha:stop # scripts/ha-local.sh; then eval "$(bash scripts/ha-local.sh env)"
npm run fixtures:record    # re-record test/fixtures/recorded from a running fixture
```

- Unit tests (135) use a fake Home Assistant (`test/fake-ha.ts`: fetch and WebSocket fakes) and payloads
  recorded from the real 2026.9.4 (`test/fixtures/recorded`, made by `scripts/record-fixtures.ts`,
  recorded again on 15 Oct 2026 with the plug uptime and the bridge's legacy named entities).
- Integration tests (18 plus the workerd smoke test) are tagged `integration` (vitest 5 tags) and skip
  unless `HA_URL` and `HA_TOKEN` are set; with a hub configured, test files run one at a time because
  they share it. With `HA_LOG_FILE` set (ha-local.sh and CI set it) the wrong token test also counts
  the rejected logins Home Assistant writes to its log.
- `test/integration/workerd.integration.test.ts` (tags `integration`, `workerd`) starts
  `wrangler dev` on 127.0.0.1:8742 (inspector 8743), runs `worker/smoke.ts` (10 steps) against the hub,
  and kills the process group. wrangler's own workerd also listens on three random loopback ports
  outside 8741 to 8749 for its internal services (seen as 33841, 35061 and 38537 in one run); no
  wrangler flag sets them. They live only as long as the test's wrangler process.
- `scripts/ha-local.sh` runs hass from a local Home Assistant venv by path (`HA_HOME`, default `packages/adapter-ha/.ha`; create it with `uv venv --python 3.14 .ha/.venv && uv pip install --python .ha/.venv homeassistant==2026.9.4`), with
  `PYTHONDONTWRITEBYTECODE=1` so not even a bytecode cache lands in it, and a fresh copy of the
  fixture config in `.runtime/config` each start. It onboards headlessly and writes a 30 day token to `.secrets/ha.json` (mode 600, git
  ignored), which `stop` deletes. Port 8741.
- `HA_RESULTS_DIR` picks where a run writes `integration-timings.json` and `workerd-smoke.json`
  (default `.runtime/results`, git ignored). The runs quoted below wrote straight into the tracked
  `results/` directory, together with each run's console output (`integration-sh.txt`, paths shortened
  to `<repo>`) and the machine's load average right after it (`run.json`).


## Measured (15 Oct 2026, dev VM, loopback, `scripts/integration.sh`)

Evidence: `results/2026-10-15-round2-run{1,2,3}/`, three consecutive runs with the final code and
fixture, all 19 live tests green in each (vitest 19.9, 19.4 and 19.4 s). The VM is shared with other
builds and was busy: load average (1, 5, 15 min, 16 cores) right after each run 21.86/18.66/13.79,
19.40/18.34/13.82 and 24.04/19.42/14.29, so these numbers are higher and noisier than on an idle
machine. Home Assistant start to ready (boot, onboarding, setup) 5852, 5168 and 4847 ms; core RUNNING
3884, 3142 and 2994 ms after launch; onboarding 829, 735 and 746 ms; long lived token 27, 32 and 13 ms.

| Adapter call (live, p50 ms) | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| hubStatus | 2.6 | 3.5 | 1.5 |
| listEntities (automation references included, p50 of 2) | 9.8 | 11.5 | 13.8 |
| getEntity | 2.4 | 4.5 | 2.0 |
| getEntity of an automation (references included) | 1.6 | 7.9 | 1.9 |
| callService, flash step (guard included, p50 of 4) | 5.3 | 5.1 | 6.3 |
| callService refused by the guard (p50 of 13) | 1.6 | 0.9 | 4.5 |
| events, all entities, power cut window | 32.6 | 33.0 | 36.5 |
| events, six circuit devices | 18.4 | 16.7 | 20.1 |
| signals | 15.0 | 7.1 | 11.0 |
| registryUpdate name with read back (p50 of 2) | 5.4 | 3.6 | 3.2 |
| registryRemove with read back | 9.3 | 3.0 | 2.4 |
| selectOption with read back | 6.8 | 4.8 | 7.3 |
| reloadIntegration bridge (config entry, unavailable to available) | 7.5 | 3.7 | 10.3 |
| reloadIntegration demo (config entry) | 20.6 | 24.3 | 38.0 |
| reloadIntegration template (YAML) | 43.2 | 29.2 | 27.1 |
| integrations / cloudStatus | 1.2 / 3.5 | 1.1 / 3.1 | 1.7 / 13.6 |
| mains back to last device back | 2 | 8 | 3 |

Rejected logins Home Assistant logged for five calls started together with a wrong token (REST and
websocket reads) plus a sixth inside the hold: 1, 1 and 1. workerd: wrangler dev ready in 1572, 1235
and 1547 ms; all 10 steps passed with runtime "Cloudflare-Workers"; its listEntities returned 168
entities. Times inside workerd only advance across I/O, so its per step numbers are coarse; its events
step includes a deliberate 1.6 s wait for the recorder.

Before the last test fix, three runs with the same adapter code are kept in
`results/2026-10-15-round2-before-test-fix-run{1,2,3}/`: run 1 failed one live test (load average
28.69), because the plug's once a second uptime reading after the power came back landed after the
test's fixed 1.6 s recorder wait, so the uptime reset was outside the window it read. The test now
waits for that reading first; runs 2 and 3 passed.

## Versions

Home Assistant 2026.9.4 (local venv: CPython 3.14.7), Node 22.22.1, TypeScript 6.0.3, vitest 5.0.2,
wrangler 4.144.0, @cloudflare/workers-types 5.20260929.1 (pinned; added as this workspace's
devDependency for the Workers type check), container
`ghcr.io/home-assistant/home-assistant:2026.9.4@sha256:3e6710a7ab2a61311d9d899b719f6c3657791c63e8f4942cec4ebc42401d6b76`,
actions pinned by SHA (checkout v7.0.1, setup-node v7.0.0, upload-artifact v7.0.1),
actionlint 1.7.12 and shellcheck 0.11.0 reused from the venv folder's tools by path. No other packages added.

## Known limits

- The CI job has not run yet (no Docker on the dev VM); first run on GitHub retires that risk.
- Ethernet and Bluetooth devices map to `wifi` until the protocol has values for them.
- `events()` without `entityIds` asks history for every entity; on very large homes pass `entityIds`.
- The guard checks what a call reaches, not what reacts to it: a garage opener shown as a plain switch
  with an ordinary name, the actions of template entities and automations triggered by a change are
  outside it (see Safety guard).
- Past registry changes and Matter boot reasons are not available from Home Assistant (see Events).
- Automation references are cached for `registryCacheMs` (30 s), so an automation edited just now may
  show its old references until then.
- The fixture's 1 s mains sampling and template reloads are simulation artifacts, documented above.
