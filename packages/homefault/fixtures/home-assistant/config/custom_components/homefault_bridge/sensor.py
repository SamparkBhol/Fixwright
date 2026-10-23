"""Two legacy named sensors on the bridge device (has_entity_name False).

Home Assistant 2026.9 names them by joining the device name with the entity name after stripping a
leading device name: "Hallway Bridge Signal" stays "Hallway Bridge Signal", "Firmware version"
becomes "Hallway Bridge Firmware version". The adapter predicts both.
"""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import BRIDGE_ID, DOMAIN

SENSORS = (
    ("bridge_signal", "Hallway Bridge Signal", 200),
    ("bridge_firmware", "Firmware version", "1.4.2 (simulated)"),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities(BridgeSensor(*sensor) for sensor in SENSORS)


class BridgeSensor(SensorEntity):
    """A static diagnostic value of the bridge."""

    _attr_has_entity_name = False
    _attr_should_poll = False
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, key: str, name: str, value: int | str) -> None:
        self._attr_unique_id = f"homefault_{key}"
        self._attr_name = name
        self._attr_native_value = value
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, BRIDGE_ID)})
