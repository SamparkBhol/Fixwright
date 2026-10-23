"""Lights behind the homefault simulated bridge."""

from __future__ import annotations

from typing import Any

from homeassistant.components.light import ColorMode, LightEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event

from .const import DOMAIN, LINK, MANUFACTURER

# key, device name, simulated IEEE address, link quality
BULBS = (
    ("bridge_lamp", "Bridge Lamp", "00:17:88:01:0b:00:00:01", 121),
    ("bridge_spot", "Bridge Spot", "00:17:88:01:0b:00:00:02", 87),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry[str],
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add one light per simulated bulb, each a device behind the bridge."""
    async_add_entities(BridgeLight(*bulb, entry.runtime_data) for bulb in BULBS)


class BridgeLight(LightEntity):
    """A bulb that loses its bridge connection with the link and only gets it back on a reload."""

    _attr_has_entity_name = True
    _attr_name = None
    _attr_should_poll = False
    _attr_color_mode = ColorMode.ONOFF
    _attr_supported_color_modes = {ColorMode.ONOFF}
    _attr_is_on = False

    def __init__(
        self, key: str, name: str, ieee: str, linkquality: int, via: str
    ) -> None:
        self._attr_unique_id = f"homefault_{key}"
        self._attr_extra_state_attributes = {"linkquality": linkquality}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, key)},
            connections={("zigbee", ieee)},
            name=name,
            manufacturer=MANUFACTURER,
            model="Simulated bridge bulb",
            via_device_id=via,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_track_state_change_event(self.hass, [LINK], self._link_changed)
        )

    @callback
    def _link_changed(self, event: Event[EventStateChangedData]) -> None:
        """A dropped link makes the bulb unavailable until the entry is reloaded."""
        new_state = event.data["new_state"]
        if self._attr_available and (new_state is None or new_state.state != "on"):
            self._attr_available = False
            self.async_write_ha_state()

    async def async_turn_on(self, **kwargs: Any) -> None:
        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        self._attr_is_on = False
        self.async_write_ha_state()
