"""Haus 3D Viewer: shows scanned STL floor models with live entity markers."""
from __future__ import annotations

import json
import logging
import re

import voluptuous as vol
from aiohttp import web

import homeassistant.helpers.config_validation as cv
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import (
    API_FLOOR_MARKER_PATH,
    API_FLOOR_MARKERS_PATH,
    API_FLOOR_MODEL_PATH,
    API_FLOOR_POSITIONS_PATH,
    API_FLOORS_LIST_PATH,
    CONF_FLOOR_ID,
    CONF_FLOOR_NAME,
    CONF_FLOOR_POSITIONS_PATH,
    CONF_FLOOR_STL_PATH,
    CONF_FLOORS,
    CONF_STATE_COLORS,
    DEFAULT_STATE_COLORS,
    DOMAIN,
    STATIC_URL_BASE,
)
from .panel import async_register_panel

_LOGGER = logging.getLogger(__name__)

FLOOR_SCHEMA = vol.Schema(
    {
        vol.Optional(CONF_FLOOR_ID): cv.string,
        vol.Required(CONF_FLOOR_NAME): cv.string,
        vol.Required(CONF_FLOOR_STL_PATH): cv.isfile,
        vol.Required(CONF_FLOOR_POSITIONS_PATH): cv.isfile,
    }
)

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                # At least one floor is required (e.g. "Ebene 0" / ground floor).
                # Add more entries to this list to add more floors.
                vol.Required(CONF_FLOORS): vol.All(
                    cv.ensure_list, [FLOOR_SCHEMA], vol.Length(min=1)
                ),
                vol.Optional(
                    CONF_STATE_COLORS, default=DEFAULT_STATE_COLORS
                ): {cv.string: cv.string},
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "ebene"


def _build_floor_registry(floors_config: list[dict]) -> dict[str, dict]:
    """Assign a stable, unique id to every configured floor."""
    registry: dict[str, dict] = {}
    for floor in floors_config:
        floor_id = floor.get(CONF_FLOOR_ID) or _slugify(floor[CONF_FLOOR_NAME])
        base_id = floor_id
        suffix = 2
        while floor_id in registry:
            floor_id = f"{base_id}-{suffix}"
            suffix += 1
        registry[floor_id] = floor
    return registry


class House3DFloorsListView(HomeAssistantView):
    """Lists the configured floors so the frontend can build a switcher."""

    url = API_FLOORS_LIST_PATH
    name = f"api:{DOMAIN}:floors"
    requires_auth = True

    def __init__(self, floors: dict[str, dict]) -> None:
        self._floors = floors

    async def get(self, request: web.Request) -> web.Response:
        return web.json_response(
            [
                {"id": floor_id, "name": floor[CONF_FLOOR_NAME]}
                for floor_id, floor in self._floors.items()
            ]
        )


class House3DModelView(HomeAssistantView):
    """Serves a floor's STL file to the frontend panel."""

    url = API_FLOOR_MODEL_PATH
    name = f"api:{DOMAIN}:floor_model"
    requires_auth = True

    def __init__(self, hass: HomeAssistant, floors: dict[str, dict]) -> None:
        self._hass = hass
        self._floors = floors

    async def get(self, request: web.Request, floor_id: str) -> web.Response:
        floor = self._floors.get(floor_id)
        if floor is None:
            return web.Response(status=404)
        try:
            data = await self._hass.async_add_executor_job(
                self._read_file, floor[CONF_FLOOR_STL_PATH]
            )
        except OSError as err:
            _LOGGER.error(
                "Could not read STL file %s: %s", floor[CONF_FLOOR_STL_PATH], err
            )
            return web.Response(status=404)
        return web.Response(body=data, content_type="application/sla")

    @staticmethod
    def _read_file(path: str) -> bytes:
        with open(path, "rb") as handle:
            return handle.read()


class House3DPositionsView(HomeAssistantView):
    """Serves a floor's positions JSON, enriched with the color mapping."""

    url = API_FLOOR_POSITIONS_PATH
    name = f"api:{DOMAIN}:floor_positions"
    requires_auth = True

    def __init__(
        self, hass: HomeAssistant, floors: dict[str, dict], state_colors: dict
    ) -> None:
        self._hass = hass
        self._floors = floors
        self._state_colors = state_colors

    async def get(self, request: web.Request, floor_id: str) -> web.Response:
        floor = self._floors.get(floor_id)
        if floor is None:
            return web.Response(status=404)
        try:
            data = await self._hass.async_add_executor_job(
                self._read_json, floor[CONF_FLOOR_POSITIONS_PATH]
            )
        except (OSError, json.JSONDecodeError) as err:
            _LOGGER.error(
                "Could not read positions file %s: %s",
                floor[CONF_FLOOR_POSITIONS_PATH],
                err,
            )
            return web.Response(status=404)
        data["state_colors"] = self._state_colors
        return web.json_response(data)

    @staticmethod
    def _read_json(path: str) -> dict:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)


class House3DMarkerUpdateView(HomeAssistantView):
    """Persists an edited marker's x/y/z back into positions.json."""

    url = API_FLOOR_MARKER_PATH
    name = f"api:{DOMAIN}:floor_marker_update"
    requires_auth = True

    def __init__(self, hass: HomeAssistant, floors: dict[str, dict]) -> None:
        self._hass = hass
        self._floors = floors

    async def put(
        self, request: web.Request, floor_id: str, marker_index: str
    ) -> web.Response:
        floor = self._floors.get(floor_id)
        if floor is None:
            return web.Response(status=404)
        try:
            index = int(marker_index)
        except ValueError:
            return web.Response(status=400, text="marker_index muss eine Zahl sein")

        try:
            body = await request.json()
            x = float(body["x"])
            y = float(body["y"])
            z = float(body["z"])
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            return web.Response(status=400, text="x/y/z (Zahlen) erforderlich")

        try:
            updated = await self._hass.async_add_executor_job(
                self._update_marker, floor[CONF_FLOOR_POSITIONS_PATH], index, x, y, z
            )
        except IndexError:
            return web.Response(status=404, text="marker_index außerhalb des Bereichs")
        except (OSError, json.JSONDecodeError) as err:
            _LOGGER.error(
                "Could not update positions file %s: %s",
                floor[CONF_FLOOR_POSITIONS_PATH],
                err,
            )
            return web.Response(status=500)

        return web.json_response(updated)

    @staticmethod
    def _update_marker(path: str, index: int, x: float, y: float, z: float) -> dict:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        markers = data.get("markers", [])
        if not 0 <= index < len(markers):
            raise IndexError(f"marker index {index} out of range")
        markers[index]["x"] = x
        markers[index]["y"] = y
        markers[index]["z"] = z
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True, ensure_ascii=False)
        return markers[index]


class House3DMarkerCreateView(HomeAssistantView):
    """Appends a new marker to positions.json (the "+ Punkt" button in the panel)."""

    url = API_FLOOR_MARKERS_PATH
    name = f"api:{DOMAIN}:floor_marker_create"
    requires_auth = True

    def __init__(self, hass: HomeAssistant, floors: dict[str, dict]) -> None:
        self._hass = hass
        self._floors = floors

    async def post(self, request: web.Request, floor_id: str) -> web.Response:
        floor = self._floors.get(floor_id)
        if floor is None:
            return web.Response(status=404)

        try:
            body = await request.json()
            x = float(body["x"])
            y = float(body["y"])
            z = float(body["z"])
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            return web.Response(status=400, text="x/y/z (Zahlen) erforderlich")
        entity_id = str(body.get("entity_id", ""))
        room = str(body.get("room", ""))
        label = str(body.get("label", ""))

        try:
            created = await self._hass.async_add_executor_job(
                self._append_marker,
                floor[CONF_FLOOR_POSITIONS_PATH],
                entity_id,
                room,
                label,
                x,
                y,
                z,
            )
        except (OSError, json.JSONDecodeError) as err:
            _LOGGER.error(
                "Could not append to positions file %s: %s",
                floor[CONF_FLOOR_POSITIONS_PATH],
                err,
            )
            return web.Response(status=500)

        return web.json_response(created)

    @staticmethod
    def _append_marker(
        path: str, entity_id: str, room: str, label: str, x: float, y: float, z: float
    ) -> dict:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        markers = data.setdefault("markers", [])
        new_marker = {
            "entity_id": entity_id,
            "room": room,
            "label": label,
            "x": x,
            "y": y,
            "z": z,
        }
        markers.append(new_marker)
        index = len(markers) - 1
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True, ensure_ascii=False)
        return {"index": index, **new_marker}


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the Haus 3D Viewer integration from YAML."""
    conf = config[DOMAIN]
    floors = _build_floor_registry(conf[CONF_FLOORS])
    hass.data[DOMAIN] = {"floors": floors, CONF_STATE_COLORS: conf[CONF_STATE_COLORS]}

    www_path = hass.config.path(f"custom_components/{DOMAIN}/www")
    await _async_register_static_path(hass, STATIC_URL_BASE, www_path)

    hass.http.register_view(House3DFloorsListView(floors))
    hass.http.register_view(House3DModelView(hass, floors))
    hass.http.register_view(
        House3DPositionsView(hass, floors, conf[CONF_STATE_COLORS])
    )
    hass.http.register_view(House3DMarkerUpdateView(hass, floors))
    hass.http.register_view(House3DMarkerCreateView(hass, floors))

    await async_register_panel(hass)

    _LOGGER.debug("Haus 3D Viewer set up with floors: %s", list(floors))
    return True


async def _async_register_static_path(
    hass: HomeAssistant, url_path: str, file_path: str
) -> None:
    """Serve the panel's www/ folder, across old and new HA core APIs."""
    try:
        # HA 2024.7+
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(url_path, file_path, cache_headers=False)]
        )
    except ImportError:
        # Older HA core: sync call, deprecated but still supported.
        hass.http.register_static_path(url_path, file_path, cache_headers=False)
