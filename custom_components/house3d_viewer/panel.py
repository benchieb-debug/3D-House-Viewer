"""Registers the Haus 3D sidebar panel."""
from __future__ import annotations

from homeassistant.components import panel_custom
from homeassistant.core import HomeAssistant

from .const import (
    API_BASE_PATH,
    PANEL_ICON,
    PANEL_JS_FILENAME,
    PANEL_TITLE,
    PANEL_URL_PATH,
    STATIC_URL_BASE,
    WEBCOMPONENT_NAME,
)


async def async_register_panel(hass: HomeAssistant) -> None:
    """Register the custom panel with the Home Assistant sidebar."""
    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=WEBCOMPONENT_NAME,
        frontend_url_path=PANEL_URL_PATH,
        module_url=f"{STATIC_URL_BASE}/{PANEL_JS_FILENAME}",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        embed_iframe=False,
        require_admin=False,
        config={
            "api_base": API_BASE_PATH,
        },
    )
