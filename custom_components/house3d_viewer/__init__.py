"""Haus 3D Viewer: shows a scanned STL house model with live entity markers."""
from __future__ import annotations

import json
import logging

import voluptuous as vol
from aiohttp import web

import homeassistant.helpers.config_validation as cv
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import (
    API_MODEL_PATH,
    API_POSITIONS_PATH,
    CONF_POSITIONS_PATH,
    CONF_STATE_COLORS,
    CONF_STL_PATH,
    DEFAULT_STATE_COLORS,
    DOMAIN,
    STATIC_URL_BASE,
)
from .panel import async_register_panel

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                vol.Required(CONF_STL_PATH): cv.isfile,
                vol.Required(CONF_POSITIONS_PATH): cv.isfile,
                vol.Optional(
                    CONF_STATE_COLORS, default=DEFAULT_STATE_COLORS
                ): {cv.string: cv.string},
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)


class House3DModelView(HomeAssistantView):
    """Serves the configured STL file to the frontend panel."""

    url = API_MODEL_PATH
    name = f"api:{DOMAIN}:model"
    requires_auth = True

    def __init__(self, hass: HomeAssistant, stl_path: str) -> None:
        self._hass = hass
        self._stl_path = stl_path

    async def get(self, request: web.Request) -> web.Response:
        try:
            data = await self._hass.async_add_executor_job(
                self._read_file, self._stl_path
            )
        except OSError as err:
            _LOGGER.error("Could not read STL file %s: %s", self._stl_path, err)
            return web.Response(status=404)
        return web.Response(body=data, content_type="application/sla")

    @staticmethod
    def _read_file(path: str) -> bytes:
        with open(path, "rb") as handle:
            return handle.read()


class House3DPositionsView(HomeAssistantView):
    """Serves the positions JSON, enriched with the configured color mapping."""

    url = API_POSITIONS_PATH
    name = f"api:{DOMAIN}:positions"
    requires_auth = True

    def __init__(
        self, hass: HomeAssistant, positions_path: str, state_colors: dict
    ) -> None:
        self._hass = hass
        self._positions_path = positions_path
        self._state_colors = state_colors

    async def get(self, request: web.Request) -> web.Response:
        try:
            data = await self._hass.async_add_executor_job(
                self._read_json, self._positions_path
            )
        except (OSError, json.JSONDecodeError) as err:
            _LOGGER.error(
                "Could not read positions file %s: %s", self._positions_path, err
            )
            return web.Response(status=404)
        data["state_colors"] = self._state_colors
        return web.json_response(data)

    @staticmethod
    def _read_json(path: str) -> dict:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the Haus 3D Viewer integration from YAML."""
    conf = config[DOMAIN]
    hass.data[DOMAIN] = conf

    www_path = hass.config.path(f"custom_components/{DOMAIN}/www")
    await _async_register_static_path(hass, STATIC_URL_BASE, www_path)

    hass.http.register_view(House3DModelView(hass, conf[CONF_STL_PATH]))
    hass.http.register_view(
        House3DPositionsView(
            hass, conf[CONF_POSITIONS_PATH], conf[CONF_STATE_COLORS]
        )
    )

    await async_register_panel(hass)

    _LOGGER.debug(
        "Haus 3D Viewer set up (stl=%s, positions=%s)",
        conf[CONF_STL_PATH],
        conf[CONF_POSITIONS_PATH],
    )
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
