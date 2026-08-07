"""Constants for the Haus 3D Viewer integration."""

DOMAIN = "house3d_viewer"

CONF_FLOORS = "floors"
CONF_FLOOR_ID = "id"
CONF_FLOOR_NAME = "name"
CONF_FLOOR_STL_PATH = "stl_path"
CONF_FLOOR_POSITIONS_PATH = "positions_path"
CONF_STATE_COLORS = "state_colors"

# Fallback colors used whenever an entity's state isn't covered by the
# user-configured state_colors mapping.
DEFAULT_STATE_COLORS = {
    "on": "#2ecc71",
    "off": "#e74c3c",
    "unavailable": "#9e9e9e",
    "unknown": "#9e9e9e",
}

PANEL_TITLE = "Haus 3D"
PANEL_ICON = "mdi:cube-scan"
PANEL_URL_PATH = "house3d-viewer"
WEBCOMPONENT_NAME = "house3d-viewer-panel"

STATIC_URL_BASE = "/house3d_viewer_files"
PANEL_JS_FILENAME = "house3d-panel.js"

API_BASE_PATH = f"/api/{DOMAIN}"
API_FLOORS_LIST_PATH = f"{API_BASE_PATH}/floors"
API_FLOOR_MODEL_PATH = f"{API_BASE_PATH}/floors/{{floor_id}}/model"
API_FLOOR_POSITIONS_PATH = f"{API_BASE_PATH}/floors/{{floor_id}}/positions"
