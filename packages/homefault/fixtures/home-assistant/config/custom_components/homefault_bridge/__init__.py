"""homefault simulated bridge: a test fixture integration, simulated hardware only.

It behaves like a bridge integration (a Zigbee coordinator or a Hue bridge) with a real config entry,
so the adapter's reloadIntegration is tested against Home Assistant's own mechanics rather than a
forced state:

- input_boolean.homefault_bridge_link off: the bridge's lights become unavailable, set by the
  integration itself. They stay unavailable after the link comes back, the way a bridge integration
  with a dead connection does, until the config entry is reloaded.
- Setting the entry up while the link is off raises ConfigEntryNotReady: the entry goes to
  setup_retry and its entities stay unavailable with restored: true (the hub_down shape).

Its two sensors are legacy named entities (has_entity_name False) on the bridge device, so the
adapter's friendly name prediction is checked against both of Home Assistant's naming paths.
"""

from __future__ import annotations

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv, device_registry as dr
from homeassistant.helpers.typing import ConfigType

from .const import BRIDGE_ID, BRIDGE_NAME, DOMAIN, LINK, MANUFACTURER

PLATFORMS = [Platform.LIGHT, Platform.SENSOR]
CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Create the config entry from `homefault_bridge:` in configuration.yaml."""
    if DOMAIN in config and not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN, context={"source": SOURCE_IMPORT}, data={}
            )
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry[str]) -> bool:
    """Connect to the bridge, or ask Home Assistant to retry later."""
    link = hass.states.get(LINK)
    if link is None or link.state != "on":
        raise ConfigEntryNotReady("the bridge does not answer on the network")
    bridge = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, BRIDGE_ID)},
        name=BRIDGE_NAME,
        manufacturer=MANUFACTURER,
        model="Simulated Zigbee bridge",
    )
    # The lights sit behind the bridge device (via_device_id).
    entry.runtime_data = bridge.id
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
