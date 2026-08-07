// Haus 3D Viewer - custom Home Assistant sidebar panel.
//
// Renders the configured STL floor models with translucent walls + edge
// outlines, and places colored markers for each entity from the positions
// JSON. Marker color follows the live entity state (configurable mapping,
// see const.py DEFAULT_STATE_COLORS / the "state_colors" YAML option).
// Clicking a marker opens Home Assistant's native more-info dialog.
// A floor switcher lets the user pick between the configured "Ebenen".

// unpkg serves three.js's examples/jsm modules with a bare "three" import
// internally, which the browser can't resolve without an import map. esm.sh
// rewrites those internal imports to resolved URLs, so use that instead.
import * as THREE from "https://esm.sh/three@0.160.0";
import { STLLoader } from "https://esm.sh/three@0.160.0/examples/jsm/loaders/STLLoader.js";
import { OrbitControls } from "https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js";

const FALLBACK_COLOR = "#9e9e9e";

class House3DViewerPanel extends HTMLElement {
  constructor() {
    super();
    this._initialized = false;
    this._markers = []; // { mesh, entityId, room, label }
    this._stateColors = {};
    this._hass = null;
    this._floors = []; // [{ id, name }]
    this._currentFloorId = null;
    this._houseMesh = null;
    this._loadToken = 0; // guards against a slow floor switch overwriting a newer one
    this._onResize = this._onResize.bind(this);
    this._onClick = this._onClick.bind(this);
  }

  // Home Assistant sets these properties directly on the element instance.
  set hass(hass) {
    const previous = this._hass;
    this._hass = hass;
    if (this._initialized) {
      this._updateMarkerColors(previous);
    }
  }

  get hass() {
    return this._hass;
  }

  set panel(panel) {
    this._panelConfig = (panel && panel.config) || {};
  }

  connectedCallback() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._buildDom();
    this._initThree();
    this._loadFloors();
    window.addEventListener("resize", this._onResize);
    this._resizeObserver = new ResizeObserver(this._onResize);
    this._resizeObserver.observe(this._container);
  }

  disconnectedCallback() {
    window.removeEventListener("resize", this._onResize);
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
    if (this._animationFrame) {
      cancelAnimationFrame(this._animationFrame);
    }
  }

  _buildDom() {
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; position: relative; height: 100%; width: 100%; }
      #container { position: absolute; inset: 0; overflow: hidden; background: var(--primary-background-color, #111); }
      #status { position: absolute; top: 12px; left: 12px; z-index: 1; font-family: var(--paper-font-body1_-_font-family, sans-serif); color: var(--primary-text-color, #eee); background: rgba(0,0,0,0.4); padding: 6px 10px; border-radius: 6px; font-size: 13px; }
      #floors { position: absolute; top: 12px; right: 12px; z-index: 1; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 60%; }
      .floor-btn { font-family: var(--paper-font-body1_-_font-family, sans-serif); font-size: 13px; padding: 6px 14px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.3); background: rgba(0,0,0,0.4); color: var(--primary-text-color, #eee); cursor: pointer; }
      .floor-btn.active { background: var(--primary-color, #03a9f4); border-color: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); font-weight: 500; }
      canvas { display: block; touch-action: none; }
    `;
    const container = document.createElement("div");
    container.id = "container";

    const status = document.createElement("div");
    status.id = "status";
    status.textContent = "Lade Ebenen…";

    const floors = document.createElement("div");
    floors.id = "floors";

    container.appendChild(status);
    container.appendChild(floors);

    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(container);
    this._container = container;
    this._statusEl = status;
    this._floorsEl = floors;
  }

  _setStatus(text) {
    if (text) {
      this._statusEl.textContent = text;
      this._statusEl.style.display = "block";
    } else {
      this._statusEl.style.display = "none";
    }
  }

  _renderFloorSwitcher() {
    this._floorsEl.innerHTML = "";
    if (this._floors.length <= 1) {
      return; // nothing to switch between
    }
    for (const floor of this._floors) {
      const btn = document.createElement("button");
      btn.className = "floor-btn" + (floor.id === this._currentFloorId ? " active" : "");
      btn.textContent = floor.name;
      btn.addEventListener("click", () => this._selectFloor(floor.id));
      this._floorsEl.appendChild(btn);
    }
  }

  _initThree() {
    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    camera.position.set(6, 6, 6);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    this._container.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7);
    scene.add(dir);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    this._scene = scene;
    this._camera = camera;
    this._renderer = renderer;
    this._controls = controls;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();

    renderer.domElement.addEventListener("click", this._onClick);

    this._onResize();
    this._animate();
  }

  _animate() {
    this._animationFrame = requestAnimationFrame(() => this._animate());
    this._controls.update();
    this._renderer.render(this._scene, this._camera);
  }

  _onResize() {
    if (!this._renderer) {
      return;
    }
    // Some HA layouts briefly report a 0-height container before the page
    // finishes settling; fall back to the viewport so we never render into
    // a 0x0 canvas (which looks identical to a crashed/blank panel).
    const width = this._container.clientWidth || window.innerWidth || 1;
    const height = this._container.clientHeight || window.innerHeight || 1;
    this._camera.aspect = width / height;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(width, height);
  }

  async _loadFloors() {
    const apiBase = this._panelConfig.api_base;
    if (!apiBase) {
      this._setStatus("Panel-Konfiguration fehlt (api_base).");
      return;
    }
    try {
      const resp = await this._hass.fetchWithAuth(`${apiBase}/floors`);
      if (!resp.ok) {
        throw new Error(`floors HTTP ${resp.status}`);
      }
      this._floors = await resp.json();
      if (!this._floors.length) {
        this._setStatus("Keine Ebenen konfiguriert.");
        return;
      }
      this._selectFloor(this._floors[0].id);
    } catch (err) {
      console.error("[house3d-viewer] Konnte Ebenen nicht laden:", err);
      this._setStatus("Fehler beim Laden der Ebenen. Siehe Konsole.");
    }
  }

  _selectFloor(floorId) {
    if (floorId === this._currentFloorId) {
      return;
    }
    this._currentFloorId = floorId;
    this._renderFloorSwitcher();
    this._loadFloorData(floorId);
  }

  _clearScene() {
    if (this._houseMesh) {
      this._scene.remove(this._houseMesh);
      this._houseMesh.geometry.dispose();
      this._houseMesh.material.dispose();
      this._houseMesh = null;
    }
    for (const marker of this._markers) {
      this._scene.remove(marker.mesh);
    }
    this._markers = [];
  }

  async _loadFloorData(floorId) {
    const apiBase = this._panelConfig.api_base;
    const token = ++this._loadToken;
    this._setStatus("Lade Hausmodell…");
    this._clearScene();

    try {
      const positionsResp = await this._hass.fetchWithAuth(
        `${apiBase}/floors/${floorId}/positions`
      );
      if (!positionsResp.ok) {
        throw new Error(`positions.json HTTP ${positionsResp.status}`);
      }
      const positions = await positionsResp.json();
      if (token !== this._loadToken) {
        return; // a newer floor switch has since started
      }
      this._stateColors = positions.state_colors || {};
      this._loadModel(`${apiBase}/floors/${floorId}/model`, token);
      this._buildMarkers(positions.markers || []);
    } catch (err) {
      console.error("[house3d-viewer] Konnte Daten nicht laden:", err);
      this._setStatus("Fehler beim Laden der Haus-Daten. Siehe Konsole.");
    }
  }

  _loadModel(modelUrl, token) {
    const loader = new STLLoader();
    const accessToken =
      this._hass && this._hass.auth && this._hass.auth.data
        ? this._hass.auth.data.access_token
        : undefined;
    if (accessToken) {
      loader.setRequestHeader({ Authorization: `Bearer ${accessToken}` });
    }

    const absoluteUrl = this._hass.hassUrl(modelUrl);

    loader.load(
      absoluteUrl,
      (geometry) => {
        if (token !== this._loadToken) {
          geometry.dispose();
          return; // superseded by a newer floor switch
        }
        geometry.center();
        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
          color: 0xcfd8dc,
          transparent: true,
          opacity: 0.35,
          side: THREE.DoubleSide,
          roughness: 0.9,
          metalness: 0,
        });
        const mesh = new THREE.Mesh(geometry, material);
        this._scene.add(mesh);
        this._houseMesh = mesh;

        const edges = new THREE.EdgesGeometry(geometry, 30);
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0x37474f });
        const lines = new THREE.LineSegments(edges, lineMaterial);
        mesh.add(lines);

        this._frameCameraOn(geometry);
        this._setStatus(null);
      },
      undefined,
      (err) => {
        if (token !== this._loadToken) {
          return;
        }
        console.error("[house3d-viewer] STL-Ladefehler:", err);
        this._setStatus("Hausmodell konnte nicht geladen werden. Siehe Konsole.");
      }
    );
  }

  _frameCameraOn(geometry) {
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    if (!sphere) {
      return;
    }
    const radius = Math.max(sphere.radius, 1);
    const distance = radius * 2.5;
    this._camera.position.set(distance, distance * 0.8, distance);
    this._camera.near = Math.max(radius / 100, 0.01);
    this._camera.far = distance * 20;
    this._camera.updateProjectionMatrix();
    this._controls.target.set(0, 0, 0);
    this._controls.update();
  }

  _buildMarkers(markers) {
    const geometry = new THREE.SphereGeometry(0.08, 16, 16);

    for (const marker of markers) {
      const material = new THREE.MeshStandardMaterial({ color: FALLBACK_COLOR });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(marker.x, marker.y, marker.z);
      mesh.userData.entityId = marker.entity_id;
      this._scene.add(mesh);
      this._markers.push({
        mesh,
        entityId: marker.entity_id,
        room: marker.room,
        label: marker.label,
      });
    }

    this._updateMarkerColors();
  }

  _colorForState(state) {
    if (!state) {
      return this._stateColors.unavailable || FALLBACK_COLOR;
    }
    return (
      this._stateColors[state] ||
      this._stateColors.unknown ||
      FALLBACK_COLOR
    );
  }

  _updateMarkerColors(previousHass) {
    if (!this._hass) {
      return;
    }
    for (const marker of this._markers) {
      const stateObj = this._hass.states[marker.entityId];
      const prevStateObj = previousHass && previousHass.states[marker.entityId];
      if (stateObj === prevStateObj) {
        continue;
      }
      const state = stateObj ? stateObj.state : "unavailable";
      marker.mesh.material.color.set(this._colorForState(state));
    }
  }

  _onClick(event) {
    if (!this._markers.length) {
      return;
    }
    const rect = this._renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this._raycaster.setFromCamera(this._pointer, this._camera);
    const meshes = this._markers.map((m) => m.mesh);
    const hits = this._raycaster.intersectObjects(meshes, false);
    if (!hits.length) {
      return;
    }
    const hit = this._markers.find((m) => m.mesh === hits[0].object);
    if (hit) {
      this._fireMoreInfo(hit.entityId);
    }
  }

  _fireMoreInfo(entityId) {
    const event = new Event("hass-more-info", {
      bubbles: true,
      composed: true,
    });
    event.detail = { entityId };
    this.dispatchEvent(event);
  }
}

customElements.define("house3d-viewer-panel", House3DViewerPanel);
