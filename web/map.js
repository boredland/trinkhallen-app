/**
 * MapLibre GL JS glue — the one piece of the client that stays JavaScript.
 *
 * There is no maintained Rust MapLibre binding for the browser, so the WebGL
 * map renderer stays here and the wasm client drives it:
 *
 *   mountMap(el, opts, callbacks)      → map handle
 *   setDetailFeatures(handle, geojson) → the clustered `kiosks` source
 *   setSummary(handle, z, geojson)     → one pre-baked summary band source
 *   fitToUserAndNearest(handle, lat, lng)
 *   mountPicker(el, opts, callbacks)   → the /add coordinate picker
 *
 * Data loading and filtering happen in Rust (`trinkhallen_core::filters`), so
 * this module only renders what it is given. `callbacks` is optional; every
 * callback also fires as a `tk:*` window CustomEvent, so listeners outside
 * the map (sheet, panel) don't need a handle:
 *
 *   tk:map-ready       { bbox, zoom }
 *   tk:bbox-changed    { bbox, zoom }
 *   tk:origin-changed  { lat, lng }
 *   tk:open-kiosk      { id }
 *   tk:pick-coords     { lng, lat }
 *
 * `bbox` is `[w, s, e, n]`; `tk:bbox-changed` also carries the bbox string the
 * panel URL uses (`"w,s,e,n"`).
 */

import maplibregl from "maplibre-gl";

const ACCENT = "#FF2D6F";
const STYLE_BY_THEME = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
};

/** Zoom at which per-region detail data replaces the summary bands. */
export const DETAIL_ZOOM = 9;
export const SUMMARY_ZOOMS = [5, 6, 7, 8];

export function currentTheme() {
  const ds = document.documentElement.dataset["theme"];
  if (ds === "light" || ds === "dark") return ds;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveStyle() {
  return STYLE_BY_THEME[currentTheme()];
}

function isLight() {
  return currentTheme() === "light";
}

function emptyCollection() {
  return { type: "FeatureCollection", features: [] };
}

/**
 * Callback name → window CustomEvent. Every callback also fires as an event so
 * listeners that are not part of the wasm client (sheet, panel bridges) work
 * exactly like the TS bundle's `tk:*` events.
 */
const EVENTS = {
  onReady: "tk:map-ready",
  onStyle: "tk:map-style-loaded",
  onBbox: "tk:bbox-changed",
  onOrigin: "tk:origin-changed",
  onOpenKiosk: "tk:open-kiosk",
  onPick: "tk:pick-coords",
};

function fire(callbacks, name, detail) {
  try {
    callbacks?.[name]?.(detail);
  } catch (err) {
    console.error(`map callback ${name} failed:`, err);
  }
  window.dispatchEvent(new CustomEvent(EVENTS[name], { detail }));
}

// ── shared map setup ─────────────────────────────────────────────────────────

function initialView(el) {
  // Priority for initial centre:
  //   1. data-focus-lng/lat (SSR-injected on /k/:id — centre on the focused
  //      kiosk so direct deep links land on the right place)
  //   2. ?c=lat,lng&z=zoom (user-driven, persisted on moveend)
  //   3. Frankfurt default
  const params = new URL(location.href).searchParams;
  const focusLng = parseFloat(el.dataset["focusLng"] ?? "");
  const focusLat = parseFloat(el.dataset["focusLat"] ?? "");
  const hasFocus = Number.isFinite(focusLng) && Number.isFinite(focusLat);
  let center = [8.6821, 50.1109];
  if (hasFocus) center = [focusLng, focusLat];
  else if (params.get("c")) {
    const [lat, lng] = params.get("c").split(",").map(Number);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    ) {
      center = [lng, lat];
    }
  }
  let zoom = 12;
  if (hasFocus) zoom = 15;
  else {
    const z = parseFloat(params.get("z") ?? "");
    if (Number.isFinite(z) && z >= 5 && z <= 19) zoom = z;
  }
  return { center, zoom, hasFocus, pinned: hasFocus || params.has("c") };
}

function newMap(el) {
  const { center, zoom } = initialView(el);
  return new maplibregl.Map({
    container: el,
    style: resolveStyle(),
    center,
    zoom,
    minZoom: 5,
    maxZoom: 19,
    attributionControl: { compact: true },
  });
}

function viewport(map) {
  const b = map.getBounds();
  return { bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], zoom: map.getZoom() };
}

/**
 * OpenFreeMap's `dark` style paints roads almost the same shade as the base,
 * which all but disappears on our near-black canvas. Bump the road fills +
 * casings to readable greys while leaving width hierarchy intact. No-op in
 * light mode — positron's roads are already high-contrast.
 */
const DARK_ROAD_COLORS = {
  highway_path: "#2f2f2f",
  highway_minor: "#3d3d3d",
  highway_major_subtle: "#454545",
  highway_major_casing: "#5a5a5a",
  highway_major_inner: "#6a6a6a",
  highway_motorway_casing: "#6f6f6f",
  highway_motorway_inner: "#8a8a8a",
};

function boostDarkRoads(map) {
  if (isLight()) return;
  for (const [layerId, color] of Object.entries(DARK_ROAD_COLORS)) {
    // getLayer guards against the upstream style renaming/removing a layer —
    // a missing road layer should never throw and break the map.
    if (map.getLayer(layerId)) map.setPaintProperty(layerId, "line-color", color);
  }
}

// ── main map ────────────────────────────────────────────────────────────────

/**
 * Mount the clustered kiosk map.
 *
 * @param {HTMLElement} el container (usually `#map`)
 * @param {object} [opts] `{ geolocate: true }` adds the GPS control
 * @param {object} [callbacks] see the module docs
 * @returns {{ setDetailFeatures: Function, setSummary: Function, getViewport: Function }}
 */
export function mountMap(el, opts = {}, callbacks = {}) {
  const map = newMap(el);
  const wantGeolocate = opts.geolocate !== false;

  let geolocate = null;
  if (wantGeolocate) {
    geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 8000 },
      trackUserLocation: false,
      showAccuracyCircle: false,
      // animate:false keeps the control's default fitBounds from showing a
      // wide intermediate view (e.g. continent-scale when accuracy ≥ 10 km).
      // We override with easeTo in fitToUserAndNearest.
      fitBoundsOptions: { animate: false },
    });
    geolocate.on("geolocate", (e) => {
      const lng = e.coords.longitude;
      const lat = e.coords.latitude;
      fire(callbacks, "onOrigin", { lat, lng });
    });
    map.addControl(geolocate, "top-right");
  }

  const summarySourceId = (z) => `kiosks-summary-z${z}`;
  const summaryBubbleId = (z) => `summary-bubble-z${z}`;
  const summaryCountId = (z) => `summary-count-z${z}`;

  /** Add the kiosk source + layers. Idempotent — safe to re-call after a
   *  `map.setStyle()` (which strips custom sources/layers).
   *
   *  Sources, controlled by per-layer min/maxzoom:
   *    - kiosks-summary-z{5..8}: pre-baked supercluster snapshot for that
   *      zoom band, one cluster bubble per layer at zoom range [z, z+1).
   *    - kiosks: per-region union for the current viewport, clustered live. */
  function addKioskLayers() {
    if (map.getSource("kiosks")) return;

    for (const z of SUMMARY_ZOOMS) {
      map.addSource(summarySourceId(z), { type: "geojson", data: emptyCollection() });
    }

    map.addSource("kiosks", {
      type: "geojson",
      data: emptyCollection(),
      cluster: true,
      clusterMaxZoom: 15,
      clusterRadius: 48,
    });

    const clusterCountColor = isLight() ? "#F5F2EC" : "#0A0A0A";
    const dotStroke = isLight() ? "#F5F2EC" : "#0A0A0A";

    for (const z of SUMMARY_ZOOMS) {
      // Each layer is visible only inside its own [z, z+1) zoom band. The
      // last band runs up to DETAIL_ZOOM where the live cluster source takes
      // over — so the union of all bands covers exactly [5, DETAIL_ZOOM).
      map.addLayer({
        id: summaryBubbleId(z),
        type: "circle",
        source: summarySourceId(z),
        minzoom: z,
        maxzoom: z + 1,
        paint: {
          "circle-color": ACCENT,
          "circle-stroke-color": "#FFD93D",
          "circle-stroke-width": 1.5,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "point_count"],
            1,
            8,
            10,
            14,
            100,
            20,
            500,
            26,
            2000,
            32,
          ],
          "circle-opacity": 0.92,
        },
      });

      map.addLayer({
        id: summaryCountId(z),
        type: "symbol",
        source: summarySourceId(z),
        minzoom: z,
        maxzoom: z + 1,
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Medium"],
          "text-size": 12,
          "text-allow-overlap": true,
        },
        paint: { "text-color": clusterCountColor },
      });
    }

    map.addLayer({
      id: "clusters",
      type: "circle",
      source: "kiosks",
      minzoom: DETAIL_ZOOM,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": ACCENT,
        "circle-stroke-color": "#FFD93D",
        "circle-stroke-width": 1.5,
        "circle-radius": ["step", ["get", "point_count"], 16, 25, 22, 100, 28, 500, 34],
        "circle-opacity": 0.92,
      },
    });

    map.addLayer({
      id: "cluster-count",
      type: "symbol",
      source: "kiosks",
      minzoom: DETAIL_ZOOM,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Noto Sans Medium"],
        "text-size": 12,
      },
      paint: { "text-color": clusterCountColor },
    });

    // Unclustered single dot — grows as we zoom in.
    map.addLayer({
      id: "unclustered",
      type: "circle",
      source: "kiosks",
      minzoom: DETAIL_ZOOM,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": ACCENT,
        "circle-stroke-color": dotStroke,
        "circle-stroke-width": 1.5,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 6, 17, 9],
        "circle-opacity": 1,
      },
    });

    // Selection halo — a single amber ring around the currently-open kiosk.
    // The filter starts as a never-match; tk:selected-kiosk events swap the id.
    map.addLayer({
      id: "unclustered-selected",
      type: "circle",
      source: "kiosks",
      minzoom: DETAIL_ZOOM,
      filter: ["==", ["get", "id"], ""],
      paint: {
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": "#FFD93D",
        "circle-stroke-width": 3,
        "circle-stroke-opacity": 0.95,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 9, 14, 13, 17, 18],
      },
    });
  }

  map.on("load", () => {
    addKioskLayers();

    // Auto-locate: when the URL pins no location and the user has already
    // granted geolocation, zoom to their position exactly as a tap on the GPS
    // control would. A "prompt"/"denied" state stays silent — we never surface
    // an unsolicited permission prompt.
    const { pinned } = initialView(el);
    if (!pinned && geolocate) {
      navigator.permissions
        ?.query({ name: "geolocation" })
        .then((status) => {
          if (status.state === "granted") geolocate.trigger();
        })
        .catch(() => {});
    }

    for (const z of SUMMARY_ZOOMS) {
      map.on("click", summaryBubbleId(z), (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== "Point") return;
        // Step into the next zoom band so the cluster visibly refines (or, at
        // the last band, crosses into per-region detail).
        map.easeTo({
          center: f.geometry.coordinates,
          zoom: z + 1,
          duration: 500,
          essential: true,
        });
      });
      map.on("mouseenter", summaryBubbleId(z), () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", summaryBubbleId(z), () => (map.getCanvas().style.cursor = ""));
    }

    map.on("click", "clusters", async (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
      const clusterId = features[0]?.properties?.["cluster_id"];
      if (clusterId === undefined) return;
      const source = map.getSource("kiosks");
      const zoom = await source.getClusterExpansionZoom(clusterId);
      const geom = features[0]?.geometry;
      if (geom?.type !== "Point") return;
      map.easeTo({ center: geom.coordinates, zoom });
    });

    map.on("click", "unclustered", (e) => {
      const f = e.features?.[0];
      const id = f?.properties?.id;
      if (!id) return;
      // The sheet controller listens for this event and opens /k/:id in the
      // slide-over panel.
      fire(callbacks, "onOpenKiosk", { id });
    });

    map.on("mouseenter", "clusters", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "clusters", () => (map.getCanvas().style.cursor = ""));
    map.on("mouseenter", "unclustered", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "unclustered", () => (map.getCanvas().style.cursor = ""));

    fire(callbacks, "onReady", viewport(map));
  });

  let refreshTimer;
  map.on("moveend", () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const view = viewport(map);
      fire(callbacks, "onBbox", {
        bbox: view.bbox,
        // Same string the TS bundle put into the panel URL (no rounding).
        bboxString: view.bbox.join(","),
        zoom: view.zoom,
      });
      // Persist viewport to URL so refresh / share / browser-back preserves
      // the user's position. replaceState (not pushState) — we don't want
      // every pan to bloat the back-button stack.
      const center = map.getCenter();
      const u = new URL(location.href);
      u.searchParams.set("c", `${center.lat.toFixed(5)},${center.lng.toFixed(5)}`);
      u.searchParams.set("z", map.getZoom().toFixed(2));
      history.replaceState(null, "", u.toString());
    }, 200);
  });

  // List-item click → fly to the kiosk. Padding keeps the focused point in
  // the visible map area: on desktop the sheet covers the right ~448px; on
  // mobile it covers the bottom ~90% so we leave the marker near the top.
  window.addEventListener("tk:focus-kiosk", (ev) => {
    const { lng, lat } = ev.detail ?? {};
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const desktop = window.matchMedia("(min-width: 640px)").matches;
    // Zoom past clusterMaxZoom (15) so the focused kiosk renders as an
    // individual dot — selecting one from the list and seeing a cluster is a
    // UX no-op.
    map.flyTo({
      center: [lng, lat],
      zoom: Math.max(map.getZoom(), 16),
      padding: desktop ? { right: 448 } : { bottom: Math.round(window.innerHeight * 0.55) },
      duration: 600,
      essential: true,
    });
  });

  // Selection halo — sheet.ts dispatches this as the sheet opens/closes.
  window.addEventListener("tk:selected-kiosk", (e) => {
    const id = e.detail?.id ?? null;
    if (map.getLayer("unclustered-selected")) {
      map.setFilter("unclustered-selected", ["==", ["get", "id"], id ?? ""]);
    }
  });

  // Theme toggle rebuilds the style with the matching flavor + sprite, then
  // re-adds our kiosk source/layers on the new style.
  window.addEventListener("tk:theme-changed", () => {
    map.setStyle(resolveStyle(), { diff: false });
  });

  // Whenever the style finishes loading (initial load *and* every setStyle),
  // make sure our custom source + layers are present and repopulated.
  map.on("style.load", () => {
    addKioskLayers();
    boostDarkRoads(map);
    fire(callbacks, "onStyle", viewport(map));
  });

  return {
    setDetailFeatures(geojson) {
      map.getSource("kiosks")?.setData(geojson);
    },
    setSummary(z, geojson) {
      map.getSource(`kiosks-summary-z${z}`)?.setData(geojson);
    },
    getViewport() {
      return viewport(map);
    },
    /** Fits the view to the user + nearest kiosk (see below). */
    fitToUserAndNearest(lat, lng) {
      return fitToUserAndNearest(map, lat, lng);
    },
    triggerGeolocate() {
      geolocate?.trigger();
    },
  };
}

/**
 * Fit the view to the user and their nearest kiosk so the zoom-in is as close
 * as possible while keeping the nearest marker visible. Falls back to a plain
 * ease-to z15 if the API is slow / errors / there's no data.
 */
export async function fitToUserAndNearest(map, lat, lng) {
  const fallback = () =>
    map.easeTo({
      center: [lng, lat],
      zoom: Math.max(map.getZoom(), 15),
      duration: 700,
      essential: true,
    });

  try {
    const resp = await fetch(`/api/kiosks/nearest?origin=${lat},${lng}`, {
      headers: { accept: "application/json" },
    });
    if (!resp.ok) return void fallback();
    const nearest = await resp.json();

    // 0.1m means the user is essentially on a kiosk; just zoom in.
    if (nearest.distance < 0.1) return void fallback();

    const bounds = new maplibregl.LngLatBounds()
      .extend([lng, lat])
      .extend([nearest.lng, nearest.lat]);
    map.fitBounds(bounds, {
      // Padding so both pins sit comfortably inside the visible area
      // (and account for the sidebar on desktop).
      padding: window.matchMedia("(min-width: 640px)").matches
        ? { top: 80, right: 80, bottom: 80, left: 400 }
        : { top: 80, right: 80, bottom: 80, left: 80 },
      maxZoom: 17, // never zoom in past z17 even if the kiosk is on top of us
      duration: 700,
      essential: true,
    });
  } catch {
    fallback();
  }
}

/** One feature collection for the `kiosks` source (also used by the picker). */
export function setDetailFeatures(handle, geojson) {
  handle.setDetailFeatures(geojson);
}

export function setSummary(handle, z, geojson) {
  handle.setSummary(z, geojson);
}

// ── coordinate picker (/add) ────────────────────────────────────────────────

const PHOTON_URL = "https://photon.komoot.io/reverse";
const RG_DEBOUNCE_MS = 350;
// Provenance marker: present when the value was written by Photon and the
// user hasn't touched it since. Cleared on any manual `input` event.
const PHOTON_FILLED_ATTR = "data-photon-filled";

/**
 * Mini map for picking coordinates on /add: click anywhere to drop a pin and
 * populate the form's lat/lng (plus address) inputs.
 *
 * @param {HTMLElement} el container (`#pick-map`)
 * @param {object} [opts] `{ lat, lng }` when the form already has coordinates
 * @param {object} [callbacks] `{ onPick({ lng, lat }) }`
 */
export function mountPicker(el, opts = {}, callbacks = {}) {
  const latInput = document.querySelector("input[name=lat]");
  const lngInput = document.querySelector("input[name=lng]");
  const inputs = {
    street: document.querySelector("input[name=street]"),
    number: document.querySelector("input[name=number]"),
    postalcode: document.querySelector("input[name=postalcode]"),
    city: document.querySelector("input[name=city]"),
  };
  // Any manual keypress / paste / autofill clears the Photon marker so a
  // subsequent pin update can't clobber what the user typed.
  for (const input of Object.values(inputs)) {
    input?.addEventListener("input", () => input.removeAttribute(PHOTON_FILLED_ATTR));
  }

  const initialLat = Number.isFinite(opts.lat) ? opts.lat : parseFloat(latInput?.value ?? "");
  const initialLng = Number.isFinite(opts.lng) ? opts.lng : parseFloat(lngInput?.value ?? "");
  const hasInitial = Number.isFinite(initialLat) && Number.isFinite(initialLng);

  const map = new maplibregl.Map({
    container: el,
    style: resolveStyle(),
    center: hasInitial ? [initialLng, initialLat] : [8.6821, 50.1109],
    zoom: hasInitial ? 16 : 11,
    minZoom: 5,
    maxZoom: 19,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 8000 },
      trackUserLocation: false,
      showAccuracyCircle: false,
      fitBoundsOptions: { maxZoom: 16 },
    }),
    "top-right",
  );

  // Theme swap — rebuild style + re-add the pin source on style.load.
  window.addEventListener("tk:theme-changed", () => {
    map.setStyle(resolveStyle(), { diff: false });
  });
  map.on("style.load", () => {
    if (map.getSource("pin")) return;
    map.addSource("pin", {
      type: "geojson",
      data: pinFeature(hasInitial ? [initialLng, initialLat] : null),
    });
    map.addLayer({
      id: "pin-circle",
      type: "circle",
      source: "pin",
      paint: {
        "circle-radius": 10,
        "circle-color": ACCENT,
        "circle-stroke-color": isLight() ? "#F5F2EC" : "#0A0A0A",
        "circle-stroke-width": 2,
      },
    });
  });

  map.on("click", (e) => {
    setPin(map, [e.lngLat.lng, e.lngLat.lat], latInput, lngInput);
    fire(callbacks, "onPick", { lng: e.lngLat.lng, lat: e.lngLat.lat });
    scheduleReverseGeocode(e.lngLat.lng, e.lngLat.lat, inputs);
  });

  map.on("geolocate", (e) => {
    setPin(map, [e.coords.longitude, e.coords.latitude], latInput, lngInput);
    fire(callbacks, "onPick", { lng: e.coords.longitude, lat: e.coords.latitude });
    scheduleReverseGeocode(e.coords.longitude, e.coords.latitude, inputs);
  });

  return {
    getViewport: () => viewport(map),
  };
}

function setPin(map, coords, latInput, lngInput) {
  map.getSource("pin")?.setData(pinFeature(coords));
  if (latInput) latInput.value = coords[1].toFixed(6);
  if (lngInput) lngInput.value = coords[0].toFixed(6);
}

/**
 * Reverse-geocodes (lng, lat) via Photon and fills the address fields. The
 * call is debounced — every map click re-arms the timer + aborts the in-flight
 * request, so dragging the pin only spends one HTTP round-trip on the final
 * position. Empty fields are filled; user-typed values are never overwritten.
 * Failures are silent — the form remains usable.
 */
let rgTimer;
let rgAbort;
function scheduleReverseGeocode(lng, lat, inputs) {
  clearTimeout(rgTimer);
  rgAbort?.abort();
  rgTimer = setTimeout(() => {
    rgAbort = new AbortController();
    void reverseGeocode(lng, lat, inputs, rgAbort.signal);
  }, RG_DEBOUNCE_MS);
}

async function reverseGeocode(lng, lat, inputs, signal) {
  const url = `${PHOTON_URL}?lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&lang=de`;
  let json;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return;
    json = await res.json();
  } catch {
    return;
  }
  const props = json.features?.[0]?.properties;
  if (!props) return;
  applyPhotonValue(inputs.street, props.street);
  applyPhotonValue(inputs.number, props.housenumber);
  applyPhotonValue(inputs.postalcode, props.postcode);
  // Photon labels small German municipalities `town` / `village` rather than
  // `city`. Walk through the candidates by descending specificity.
  applyPhotonValue(inputs.city, props.city ?? props.town ?? props.village ?? props.county);
}

/**
 * Writes a Photon-supplied value into an input when the input is empty, or
 * currently holds a previous Photon value (no user edits). After writing, the
 * input is tagged so future user keystrokes switch it back to "user-owned".
 */
function applyPhotonValue(input, value) {
  if (!input || !value) return;
  const isPhotonOwned = input.hasAttribute(PHOTON_FILLED_ATTR);
  const isEmpty = !input.value.trim();
  if (!isEmpty && !isPhotonOwned) return;
  if (input.value === value) return;
  input.value = value;
  input.setAttribute(PHOTON_FILLED_ATTR, "");
}

function pinFeature(coords) {
  if (!coords) return emptyCollection();
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: {} },
    ],
  };
}
