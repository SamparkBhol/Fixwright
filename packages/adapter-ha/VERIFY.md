# VERIFY: what the adapter-ha tests prove

Run `npm run check` (type checks for Node and Workers, then unit tests; integration tests skip without a
hub) and `npm run test:integration` (starts Home Assistant 2026.9.4, runs everything tagged
`integration`, stops it). Each line names the test that proves it. "Live" means against the running
Home Assistant in `test/integration/ha.integration.test.ts`.

## Contract

- [x] `createHaAdapter` returns a `HomeAdapter` with kind `home-assistant`; `now()` follows the injected
      clock. (adapter.test.ts: implements HomeAdapter)
- [x] Every `Entity`, `HouseEvent`, `Signals`, `IntegrationStatus` and `CloudStatus` the adapter returns
      passes the protocol's zod schemas, on recorded payloads and live. (map.test.ts; live: maps every
      entity / tells automation, user and no context changes apart / reads signals)
- [x] The adapter source type checks against `@cloudflare/workers-types` with no Node types
      (`tsconfig.worker.json`), and runs inside workerd: 10 of 10 steps pass under runtime
      "Cloudflare-Workers", over both `new WebSocket(url)` and the fetch Upgrade path.
      (workerd.integration.test.ts)

## Safety guard

- [x] A lock, alarm, camera or siren, a garage, gate or door cover, and anything named like one is
      refused before anything is sent, whether the call names it directly, under `target`, through
      `area_id`, `device_id` (and child devices), `floor_id`, `label_id`, `entity_id: all`, a group, a
      cover group, a scene or `scene.apply` / `scene.create` data. (guard.test.ts: refuses every way a
      call can reach a lock or a garage door; unit tests of serviceTarget, resolveIndirect,
      entityRefusal)
- [x] Mixed case reaches nothing new: entity ids are lower cased the way Home Assistant's
      `cv.entity_id` does (top level, `target`, scene data keys, `snapshot_entities`, group members),
      `all` and `none` match in any case, domain and service are lower cased, and area, device, floor
      and label ids match in any case. Values that are still not entity ids are refused as
      `unverified`. (guard.test.ts: reads entity ids the way Home Assistant does / collects values Home
      Assistant would reject / matches area, device, floor and label ids in any case / refuses a mixed
      case garage cover by its device class alone, with the name rule off)
- [x] Live, on these shapes: `scene.apply` with `LOCK.FRONT_DOOR`, `LOCK.Unlock`,
      `homeassistant.turn_off` with `Lock.Front_Door` on the default adapter, and `cover.open_cover`
      with `COVER.GARAGE_DOOR`, `homeassistant.toggle` with `Cover.garage_door` and `Cover.OPEN_COVER`
      under `target` on an adapter with the name rule off (so only the domain and device class rules
      apply), all refused as `unsafe_device`; plus the earlier shapes (area, device, floor and label of
      `cover.garage_door`, `entity_id: all`, direct calls). The garage door and the lock keep their
      state and `last_changed`. A light call on the Hallway area still goes through. (live: refuses
      every way a call can reach the garage door or the lock)
- [x] Calls whose reach cannot be checked are refused as `unverified` with their own spoken line, which
      passes the protocol's speech rules: integration services (`mqtt.publish`, also with a harmless
      `entity_id` added, `zha.issue_zigbee_cluster_command`, `zwave_js.set_value`, `knx.send`, ESPHome
      actions, `remote.send_command`), calls that reach no entity (`light.turn_on {}`, `entity_id:
      none`, `conversation.process`, `device_tracker.see`, a cover call without a target), scripts
      (also through `homeassistant.turn_on`), `automation.trigger`, `homeassistant.restart`, an unknown
      device id, and integration scenes that do not list their members. `allowServices` lets a named
      service through while still checking its entities. (guard.test.ts: refuses calls whose reach it
      cannot check / lets an allowed integration service through; unit tests of serviceRefusal,
      reachRefusal, entityRefusal)
- [x] Live: `mqtt.publish` with an entity added, `persistent_notification.create`,
      `homeassistant.turn_on` of `SCRIPT.EVENING_ROUTINE` and `input_boolean.turn_on {}` are refused as
      `unverified`; no notification was created and the porch light the script would switch did not
      change. (live: same test)
- [x] `selectOption` refuses a select named like a lock. (adapter.test.ts)
- [x] Safe calls cost one state read per entity checked. (guard.test.ts: lets safe calls through)

## Connection

- [x] Unreachable, auth and not found are different error kinds, on REST and on the websocket.
      (rest.test.ts, socket.test.ts; live: reports a wrong token as auth...)
- [x] Reads retry with jittered exponential backoff and honour Retry-After; service calls never retry;
      websocket `home_assistant_error` is not retried. (rest.test.ts, errors.test.ts)
- [x] Every request and command has a deadline; a hung request becomes a `timeout` error. (rest.test.ts,
      socket.test.ts)
- [x] One websocket handshake serves every concurrent caller, failed ones included. REST and the
      websocket login share one auth gate: until a token is accepted, one request goes out and the
      others wait for its answer; after a rejection every call fails without being sent for
      `authHoldMs`, then the next call tries again. A dead hub does not queue calls behind each other.
      (auth.test.ts; adapter.test.ts: reports a wrong token on the websocket as auth... / spends one
      rejected login on a wrong token... / does not queue calls behind each other when the hub is down)
- [x] Live: five calls started together with a wrong token (REST and websocket reads) plus a sixth
      inside the hold cost exactly one rejected login in Home Assistant's own log, in each of the three
      final runs. (live: reports a wrong token as auth, spending one rejected login...)
- [x] A handshake that could not connect is retried even for a write; a socket whose handshake ends
      after `close()` is not kept; a dropped or half open websocket is replaced. (adapter.test.ts)
- [x] The token never appears in error messages. (rest.test.ts)

## Mapping

- [x] Entities combine states, the entity registry (aliases from get_entries), devices and areas;
      registry entries without a state are `registryOnly`; disabled entries are `disabled`. (map.test.ts,
      adapter.test.ts; live: disables an entity)
- [x] A restored ghost (integration stopped providing it, registry kept it) maps to `restored: true`;
      removing it reads back as gone. (live: maps a restored ghost)
- [x] Logbook context maps to automation vs user vs none on a real power cut and restore: the breaker is
      the person (with `input_boolean.turn_off`/`turn_on`), the six devices go unavailable and come back
      on with no context, the restore log automation is `automation`. (live: `tells automation, user and
      no-context changes apart...`; map.test.ts on the recorded payloads)
- [x] The plug's uptime starting again after the power cut is an event with `data.uptime_reset: true`,
      live and on the recorded payloads; uptime ticks and other numeric wiggles are dropped, battery
      levels are kept, by id suffix or by device class `battery`. (live: same test; map.test.ts: marks
      the plug restarting..., keeps battery levels and marks uptime resets..., boot timestamp;
      adapter.test.ts: keeps battery levels of sensors whose device class says battery)
- [x] Automations carry `attributes.references` from `search/related`, ids that no longer exist
      included: live, the grow light schedule refers to `switch.grow_light_plug`, which is not in
      `listEntities()` (the engine's dead_trigger evidence), and the restore log automation refers to
      the mains sensor and the restore log helper. Without the search integration automations still list,
      without references. (live: lists what each automation refers to...; adapter.test.ts)
- [x] Logbook and history join on exact timestamps; sensors left out of the logbook still appear from
      history. (map.test.ts)
- [x] Signals come from attributes (linkquality, rssi, battery, last_seen), related sensors, the
      power on behavior select (Zigbee2MQTT, ZHA and Matter spellings), and flaps from 24 h of history.
      Out of range values are dropped, not clamped. (map.test.ts, adapter.test.ts, live)
- [x] signals() reads only what it needs: concurrent calls share one entity registry index, an entity
      with a device reads its siblings' states and never the whole state machine, and the adapter's own
      registry writes clear the index. cloudStatus() reads registry rows only for cloud connectivity
      sensors. (adapter.test.ts: reads signals with scoped requests / reads cloud status without the
      whole entity registry)
- [x] The predicted friendly name equals Home Assistant's for every entity of the live fixture with a
      state, including legacy named entities on a device, and for the recorded registry entries. (live:
      predicts the friendly name...; map.test.ts: predicts every recorded friendly name)
- [x] Integrations come from config entries; an entry with a reauth flow or an auth failure reason is
      reported as `setup_error` with reason `auth: ...`; a retrying entry is `setup_retry` with its
      reason. (map.test.ts, adapter.test.ts; live: bridge setup_retry)
- [x] Vendor cloud status is `unknown` with source "not available from Home Assistant" unless a cloud
      connectivity sensor or a retrying cloud integration says otherwise. (map.test.ts, adapter.test.ts,
      live)

## Writes

- [x] `registryUpdate` rename: registry entry and state `friendly_name` both show the new name before it
      returns; `name: null` restores the original. (live: renames through the registry)
- [x] `registryUpdate` aliases keep Home Assistant's computed name alias. (adapter.test.ts, live)
- [x] A write the hub acknowledges but never applies fails with a `readback` error. (adapter.test.ts)
- [x] `selectOption` power on behavior: select and device memory both read `previous`, and the next real
      power cut leaves every device off (the F2 repair works). (live: sets the power on behavior...)
- [x] `reloadIntegration` brings back lights the bridge integration itself marked unavailable (not a
      forced state): link down, link up, still unavailable, reload, `off`; history shows
      unavailable to off for both lights. (live: reloads a bridge integration whose lights went
      unavailable for real)
- [x] Reloaded while the bridge is still down, the entry ends in `setup_retry`: the adapter throws
      `readback` naming the state, integrations() reports `setup_retry` with the integration's reason,
      the lights are restored ghosts; once the bridge answers, a reload brings everything back.
      (live: reports a bridge that is still down...)
- [x] A forced unavailable demo light comes back with a demo config entry reload, and another forced one
      with `available` (update_entity). YAML integrations reload through their reload service.
      (live: brings a forced unavailable entity back...; adapter.test.ts)
- [x] An integration that only reloads with a restart throws `unsupported`, spoken as `no_fix` about the
      restart, never as the lock and garage door line. (adapter.test.ts)
- [x] callService returns the changed states but has no read back of its own; the flash test reads each
      step back with getEntity. (live: flashes the lamp with read back each time)

## Fixture and injection

- [x] Six devices on one circuit, each with a power on behavior select set to `on`, plus a light group
      as a second integration; a power cut brings all six back on within milliseconds with no context.
      (live)
- [x] Faults, each exercised live: real radio dropout (porch light: `unavailable`, `available`), forced
      unavailable (`unavailable` on demo lights), ghost (YAML removed, registry kept), duplicate name
      (`duplicateName` gives the landing light the name "Hallway Lamp", three entities answer to it,
      then it is undone), power cut and restore at a given time, power on behavior, bridge down and up.
- [x] Home Assistant keeps running past the 5 minute HTTP config revert window, because onboarding
      promotes the pending http config. (scripts/onboard.ts; checked by hand, see README)
- [x] hass runs with `PYTHONDONTWRITEBYTECODE=1`, so the local Home Assistant venv gets no new files; `ha-local.sh stop`
      deletes the dead instance's token. (scripts/ha-local.sh; checked with find -newer after the runs)
- [x] The measured numbers in the README come from the files in `results/2026-10-15-round2-run{1,2,3}/`
      (tracked, not git ignored), written by `scripts/integration.sh` with `HA_RESULTS_DIR` pointing there.

## CI

