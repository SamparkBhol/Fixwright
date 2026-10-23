# Home Assistant fixtures

A small Home Assistant 2026.9.4 configuration with a simulated hallway circuit, plus scripts to onboard
it headlessly and to inject faults into it with Home Assistant's own mechanisms. Use it to check that a
smart home agent finds the same faults on a real Home Assistant that it finds in SimHome.

Everything here is simulated hardware. Nothing talks to a real device or a vendor cloud.

## What is in `config/`

| Piece | What it is |
| --- | --- |
| `input_boolean.hallway_mains` | The hallway circuit breaker. Off and on again is a power cut. |
| `binary_sensor.hallway_mains_power` | Mains power as the circuit sees it. |
| Six circuit devices | `light.hallway_lamp`, `light.porch_light`, `light.landing_light`, `light.stair_light`, `light.entry_light`, `switch.hallway_smart_plug` (template entities). Each has a `select.<device>_power_on_behavior` (off, on, toggle, previous) that decides its state after power returns, like Zigbee2MQTT's `power_on_behavior` or Matter's StartUpOnOff. |
| `input_boolean.porch_light_link` | The porch bulb's radio link. Off makes the bulb really unavailable. |
| `templates/old_pairing.yaml` | The old copy of the hallway lamp left behind by a re-pair. Removing the file and reloading templates leaves a registry entry with `restored: true`, the ghost shape. |
| `custom_components/homefault_bridge` | A simulated bridge integration with its own config entry and two lights. When its link drops, its lights go unavailable and stay so until the config entry is reloaded (the hub down shape). |
| `automations.yaml` | `automation.hallway_power_restore_log` (fires on a restore) and `automation.grow_light_schedule`, which still refers to a plug that no longer exists (the dead trigger shape). |
| `demo:` | Home Assistant's demo integration, for registry mapping and a real config entry reload. |

The config binds Home Assistant to `127.0.0.1:8741` (`http:` in `configuration.yaml`).

## Run it

Start Home Assistant from a fresh copy of `config/` (the config dir is written to, so never run it on the
checked-in folder). With Docker:

```sh
cp -r fixtures/home-assistant/config .runtime-config
docker run -d --name ha --network host -e TZ=UTC \
  -v "$PWD/.runtime-config:/config" ghcr.io/home-assistant/home-assistant:2026.9.4
npm run ha:onboard          # waits for HTTP, onboards, writes .secrets/ha.json (mode 600, git ignored)
npm run ha:inject -- setup  # Hallway area, every circuit device off
```

Without Docker, a Python virtual environment with `homeassistant==2026.9.4` started as
`hass -c .runtime-config` works the same way.

`onboard.ts` creates a throwaway user and a long-lived token, promotes the pending `http:` config (Home
Assistant 2026.9 otherwise reverts to port 8123 and restarts after five minutes), waits for core state
RUNNING, and deletes every config entry that onboarding starts on its own except shopping_list (for
example google_translate, met and radio_browser, which use the network), so every run starts from the
same baseline.

## Inject faults

```sh
npm run ha:inject -- unavailable [entity]     # the porch bulb leaves its mesh, or force any entity
npm run ha:inject -- available [entity]
npm run ha:inject -- ghost                     # old pairing removed, registry entry kept (restored)
npm run ha:inject -- unghost                   # needs HA_CONFIG_DIR for ghost and unghost
npm run ha:inject -- duplicate <entity> <name> # registry rename: two entities answer to one name
npm run ha:inject -- power-cut [--at <ISO>] [--hold <ms>]
npm run ha:inject -- power-on <off|on|toggle|previous> [entity...]
npm run ha:inject -- bridge-down | bridge-up
```

Credentials come from `HA_URL` and `HA_TOKEN`, else `HA_SECRETS` (default `.secrets/ha.json`). Every
injection waits until Home Assistant shows the result. `power-cut` returns Home Assistant's own
timestamps for the breaker, the mains sensor and each device coming back, and which devices came back on.

`inject.ts` also exports each injection (`setup`, `ghost`, `powerCut`, ...) so an agent's integration
tests can import them. `ha-client.ts` is the small REST and websocket client they use: fetch and the
standard WebSocket only, every write read back.

## Things that surprised us

- The logbook can attribute a template entity's change to a stale context (an earlier user action) when
  an automation changed its source. Use timing and automation traces as evidence, not the context alone.
- Home Assistant lower cases entity ids and service names. Compare ids lower cased before any safety
  check, or `LOCK.FRONT_DOOR` slips past a guard that looks for `lock.`.
- Read the recorder only after it has caught up: right after a power cut, wait for the restore to show
  in `/api/history` before asking an agent about it.
