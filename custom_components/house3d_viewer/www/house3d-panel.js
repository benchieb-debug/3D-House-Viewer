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
    this._axesGroup = null;
    this._axesVisible = false;
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
      #topLeft { position: absolute; top: 12px; left: 12px; z-index: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
      #status { font-family: var(--paper-font-body1_-_font-family, sans-serif); color: var(--primary-text-color, #eee); background: rgba(0,0,0,0.4); padding: 6px 10px; border-radius: 6px; font-size: 13px; }
      #floors { position: absolute; top: 12px; right: 12px; z-index: 1; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 60%; }
      .floor-btn { font-family: var(--paper-font-body1_-_font-family, sans-serif); font-size: 13px; padding: 6px 14px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.3); background: rgba(0,0,0,0.4); color: var(--primary-text-color, #eee); cursor: pointer; }
      .floor-btn.active { background: var(--primary-color, #03a9f4); border-color: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); font-weight: 500; }
      #markerEdit { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2; background: rgba(20,20,20,0.92); border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; padding: 12px 14px; display: none; flex-direction: column; gap: 8px; min-width: 220px; font-family: var(--paper-font-body1_-_font-family, sans-serif); color: var(--primary-text-color, #eee); box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
      #markerEdit .me-title { font-size: 13px; font-weight: 600; opacity: 0.9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #markerEdit .me-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      #markerEdit .me-row label { width: 14px; opacity: 0.75; }
      #markerEdit .me-row input { flex: 1; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.25); color: inherit; border-radius: 6px; padding: 4px 8px; font-size: 13px; min-width: 0; }
      #markerEdit .me-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
      #markerEdit button { font-family: inherit; font-size: 13px; padding: 5px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.08); color: inherit; cursor: pointer; }
      #markerEdit .me-save { background: var(--primary-color, #03a9f4); border-color: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); font-weight: 500; }
      canvas { display: block; touch-action: none; }
    `;
    const container = document.createElement("div");
    container.id = "container";

    const topLeft = document.createElement("div");
    topLeft.id = "topLeft";

    const status = document.createElement("div");
    status.id = "status";
    status.textContent = "Lade Ebenen…";

    const axesToggle = document.createElement("button");
    axesToggle.className = "floor-btn";
    axesToggle.textContent = "Achsen";
    axesToggle.addEventListener("click", () => this._toggleAxes());

    topLeft.appendChild(status);
    topLeft.appendChild(axesToggle);

    const floors = document.createElement("div");
    floors.id = "floors";

    const markerEdit = document.createElement("div");
    markerEdit.id = "markerEdit";
    markerEdit.innerHTML = `
      <div class="me-title"></div>
      <div class="me-row"><label>X</label><input type="number" step="0.01" class="me-x"></div>
      <div class="me-row"><label>Y</label><input type="number" step="0.01" class="me-y"></div>
      <div class="me-row"><label>Z</label><input type="number" step="0.01" class="me-z"></div>
      <div class="me-actions">
        <button type="button" class="me-cancel">Abbrechen</button>
        <button type="button" class="me-save">Speichern</button>
      </div>
    `;
    markerEdit.querySelector(".me-cancel").addEventListener("click", () => this._closeMarkerEditor());
    markerEdit.querySelector(".me-save").addEventListener("click", () => this._saveMarkerEditor());

    container.appendChild(topLeft);
    container.appendChild(floors);
    container.appendChild(markerEdit);

    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(container);
    this._container = container;
    this._statusEl = status;
    this._floorsEl = floors;
    this._axesToggleEl = axesToggle;
    this._markerEditEl = markerEdit;
    this._markerEditTitleEl = markerEdit.querySelector(".me-title");
    this._markerEditXEl = markerEdit.querySelector(".me-x");
    this._markerEditYEl = markerEdit.querySelector(".me-y");
    this._markerEditZEl = markerEdit.querySelector(".me-z");
    this._editingMarkerIndex = null;
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
    this._closeMarkerEditor(); // Marker-Index gehört zur bisherigen Ebene, sonst inkonsistent
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
    this._removeAxesGroup();
  }

  _removeAxesGroup() {
    if (!this._axesGroup) {
      return;
    }
    this._scene.remove(this._axesGroup);
    this._axesGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    });
    this._axesGroup = null;
  }

  _toggleAxes() {
    this._axesVisible = !this._axesVisible;
    this._axesToggleEl.classList.toggle("active", this._axesVisible);
    if (this._axesGroup) {
      this._axesGroup.visible = this._axesVisible;
    }
  }

  // Farbige Achsenlinien vom Ursprung (Modellmittelpunkt nach geometry.center()) mit
  // X/Y/Z-Beschriftung an den Enden — als Canvas-Sprites, da Three.js keine eingebaute
  // Text-Geometrie ohne zusätzliche Font-Loader-Imports mitbringt.
  _buildAxesGroup(size) {
    const group = new THREE.Group();
    // Die geladene STL-Geometrie nutzt (0,1,0) als vertikale Achse ("nach oben") — hier als "Z"
    // beschriftet (statt "Y"), damit die Beschriftung mit dem Nutzer-Koordinatenverständnis
    // übereinstimmt: Z zeigt nach oben, X/Y liegen in der horizontalen Ebene.
    const axisDefs = [
      { dir: new THREE.Vector3(1, 0, 0), color: 0xff3b30, label: "X" },
      { dir: new THREE.Vector3(0, 0, 1), color: 0x34c759, label: "Y" },
      { dir: new THREE.Vector3(0, 1, 0), color: 0x0a84ff, label: "Z" },
    ];
    for (const axis of axisDefs) {
      const points = [new THREE.Vector3(0, 0, 0), axis.dir.clone().multiplyScalar(size)];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color: axis.color });
      group.add(new THREE.Line(geometry, material));

      const sprite = this._makeAxisLabelSprite(axis.label, axis.color, size * 0.18);
      sprite.position.copy(axis.dir.clone().multiplyScalar(size * 1.12));
      group.add(sprite);
    }
    group.visible = this._axesVisible;
    return group;
  }

  _makeAxisLabelSprite(text, color, scale) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.font = "bold 46px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 32, 34);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(scale, scale, 1);
    return sprite;
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

        this._removeAxesGroup();
        const radius = geometry.boundingSphere ? geometry.boundingSphere.radius : 1;
        this._axesGroup = this._buildAxesGroup(Math.max(radius, 1) * 0.9);
        this._scene.add(this._axesGroup);

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
    const index = this._markers.findIndex((m) => m.mesh === hits[0].object);
    if (index === -1) {
      return;
    }
    const hit = this._markers[index];
    if (hit.entityId) {
      this._fireMoreInfo(hit.entityId);
    }
    this._openMarkerEditor(hit, index);
  }

  _fireMoreInfo(entityId) {
    const event = new Event("hass-more-info", {
      bubbles: true,
      composed: true,
    });
    event.detail = { entityId };
    this.dispatchEvent(event);
  }

  // Zeigt X/Y/Z des angeklickten Markers editierbar an; Speichern schreibt die neue Position
  // dauerhaft über den Backend-Endpunkt zurück in die positions.json der aktuellen Ebene.
  // WICHTIG: _buildAxesGroup() beschriftet Three.js' vertikale Achse (mesh.position.y) im Bild
  // als "Z" und die horizontale (mesh.position.z) als "Y" (Nutzerwunsch: Z zeigt nach oben).
  // Das Formular muss dieselbe Vertauschung anwenden, sonst zeigt das "Z"-Feld einen anderen
  // Wert als die im Bild sichtbare Z-Achse. Die positions.json/PUT-Nutzlast bleibt davon
  // unberührt — dort heißen die Felder weiterhin x/y/z wie in Three.js (mesh.position direkt).
  _openMarkerEditor(marker, index) {
    this._editingMarkerIndex = index;
    const pos = marker.mesh.position;
    this._markerEditTitleEl.textContent =
      marker.label || marker.entityId || marker.room || `Marker ${index + 1}`;
    this._markerEditXEl.value = pos.x.toFixed(3);
    this._markerEditYEl.value = pos.z.toFixed(3); // "Y"-Feld ↔ Three.js Z (horizontal)
    this._markerEditZEl.value = pos.y.toFixed(3); // "Z"-Feld ↔ Three.js Y (vertikal/oben)
    this._markerEditEl.style.display = "flex";
  }

  _closeMarkerEditor() {
    this._markerEditEl.style.display = "none";
    this._editingMarkerIndex = null;
  }

  async _saveMarkerEditor() {
    if (this._editingMarkerIndex === null) {
      return;
    }
    const x = parseFloat(this._markerEditXEl.value);
    // Rückvertauschung passend zu _openMarkerEditor(): "Y"-Feld → Three.js Z, "Z"-Feld → Three.js Y.
    const z = parseFloat(this._markerEditYEl.value);
    const y = parseFloat(this._markerEditZEl.value);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return;
    }
    const apiBase = this._panelConfig.api_base;
    const index = this._editingMarkerIndex;

    try {
      const resp = await this._hass.fetchWithAuth(
        `${apiBase}/floors/${this._currentFloorId}/markers/${index}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ x, y, z }),
        }
      );
      if (!resp.ok) {
        throw new Error(`marker update HTTP ${resp.status}`);
      }
      const marker = this._markers[index];
      if (marker) {
        marker.mesh.position.set(x, y, z);
      }
      this._closeMarkerEditor();
    } catch (err) {
      console.error("[house3d-viewer] Marker-Update fehlgeschlagen:", err);
    }
  }
}

customElements.define("house3d-viewer-panel", House3DViewerPanel);
