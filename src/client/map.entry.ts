/**
 * Map island — MapLibre GL JS + clustered GeoJSON source.
 *
 * Lifecycle: read mount `data-*` attributes → instantiate map → fetch
 * `/api/kiosks?bbox=…` on every `moveend` (debounced) → push features into a
 * single `kiosks` source with built-in clustering → re-render via two
 * declarative layers (`clusters` + `unclustered`).
 *
 * No DOM rendering library; MapLibre owns the canvas and the popups are just
 * strings. The detail page is a real `/k/:id` SSR view, so a marker click
 * navigates rather than opening an in-canvas modal.
 */

import maplibregl, {
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type Map as MlMap,
} from "maplibre-gl";
// maplibre-gl.css is imported from app.entry.ts (always loaded) so its
// styles always reach the page; importing here splits into a chunk our
// manifest reader doesn't pull in transitively.
import { resolveStyle } from "./build-style";
import { applyFilters, parseFilterFromQuery } from "./client-filters";
import {
  type BBox,
  DETAIL_ZOOM,
  detailFeaturesForView,
  type FeatureCollection,
  loadSummary,
} from "./region-store";

const mount = document.getElementById("map");
if (mount instanceof HTMLElement) {
  // Priority for initial centre:
  //   1. data-focus-lng/lat (SSR-injected when /k/:id is the URL — we centre
  //      on the focused kiosk so direct deep links land on the right place)
  //   2. ?c=lat,lng&z=zoom (user-driven, persisted on moveend)
  //   3. Frankfurt default
  const params = new URL(location.href).searchParams;
  const focusLng = parseFloat(mount.dataset["focusLng"] ?? "");
  const focusLat = parseFloat(mount.dataset["focusLat"] ?? "");
  const initialCenter = (() => {
    if (Number.isFinite(focusLng) && Number.isFinite(focusLat)) {
      return [focusLng, focusLat] as [number, number];
    }
    const c = params.get("c");
    if (!c) return [8.6821, 50.1109] as [number, number];
    const [lat, lng] = c.split(",").map(Number);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat! >= -90 &&
      lat! <= 90 &&
      lng! >= -180 &&
      lng! <= 180
    ) {
      return [lng!, lat!] as [number, number];
    }
    return [8.6821, 50.1109] as [number, number];
  })();
  const initialZoom = (() => {
    if (Number.isFinite(focusLng) && Number.isFinite(focusLat)) return 15;
    const z = parseFloat(params.get("z") ?? "");
    return Number.isFinite(z) && z >= 5 && z <= 19 ? z : 12;
  })();

  const map = new maplibregl.Map({
    container: mount,
    style: resolveStyle(mount),
    center: initialCenter,
    zoom: initialZoom,
    minZoom: 5,
    maxZoom: 19,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 8000 },
    trackUserLocation: false,
    showAccuracyCircle: false,
    // animate:false keeps the control's default fitBounds from showing a
    // wide intermediate view (e.g. continent-scale when accuracy ≥ 10 km).
    // We override with easeTo immediately below.
    fitBoundsOptions: { animate: false },
  });
  geolocate.on("geolocate", (e: { coords: GeolocationCoordinates }) => {
    const userLng = e.coords.longitude;
    const userLat = e.coords.latitude;

    window.dispatchEvent(
      new CustomEvent("tk:origin-changed", {
        detail: { lat: userLat, lng: userLng },
      }),
    );

    // Try to fit the view to user + nearest kiosk so the zoom-in is as
    // close as possible while keeping the nearest marker visible. Falls
    // back to a plain ease-to z15 if the API is slow / errors / there's
    // no data.
    void fitToUserAndNearest(map, userLat, userLng);
  });
  map.addControl(geolocate, "top-right");

  /** Add the kiosk source + layers. Idempotent — safe to re-call after a
   *  `map.setStyle()` (which strips custom sources/layers).
   *
   *  Two sources, controlled by per-layer minzoom/maxzoom at DETAIL_ZOOM:
   *    - kiosks-summary: one bubble per region, shown when zoomed out far
   *      enough that individual markers would be useless (continent view).
   *    - kiosks: per-region union for the current viewport, clustered.
   *
   *  Unclustered features render as a simple coloured dot — no custom
   *  SVG. The dot scales up at high zoom; cluster-vs-unclustered
   *  visibility is driven by the cluster property MapLibre maintains. */
  function addKioskLayers(): void {
    if (map.getSource("kiosks")) return;

    map.addSource("kiosks-summary", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addSource("kiosks", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterMaxZoom: 15,
      clusterRadius: 48,
    });

    const isLight = document.documentElement.dataset["theme"] === "light";
    const clusterCountColor = isLight ? "#F5F2EC" : "#0A0A0A";
    const dotStroke = isLight ? "#F5F2EC" : "#0A0A0A";

    map.addLayer({
      id: "summary-bubble",
      type: "circle",
      source: "kiosks-summary",
      maxzoom: DETAIL_ZOOM,
      paint: {
        "circle-color": "#FF2D6F",
        "circle-stroke-color": "#FFD93D",
        "circle-stroke-width": 1.5,
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["get", "count"],
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
      id: "summary-count",
      type: "symbol",
      source: "kiosks-summary",
      maxzoom: DETAIL_ZOOM,
      layout: {
        "text-field": ["get", "count"],
        "text-font": ["Noto Sans Medium"],
        "text-size": 12,
        "text-allow-overlap": true,
      },
      paint: { "text-color": clusterCountColor },
    });

    map.addLayer({
      id: "clusters",
      type: "circle",
      source: "kiosks",
      minzoom: DETAIL_ZOOM,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#FF2D6F",
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
      paint: {
        "text-color": clusterCountColor,
      },
    });

    // Unclustered single dot — grows as we zoom in.
    map.addLayer({
      id: "unclustered",
      type: "circle",
      source: "kiosks",
      minzoom: DETAIL_ZOOM,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": "#FF2D6F",
        "circle-stroke-color": dotStroke,
        "circle-stroke-width": 1.5,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 6, 17, 9],
        "circle-opacity": 1,
      },
    });

    // Selection halo — a single amber ring around the currently-open kiosk.
    // Filter starts as a never-match; sheet.ts dispatches tk:selected-kiosk
    // events as the user opens/closes the sheet and we swap the id in.
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

  function setSelectedKiosk(id: string | null): void {
    const filter: maplibregl.FilterSpecification = ["==", ["get", "id"], id ?? ""];
    if (map.getLayer("unclustered-selected")) {
      map.setFilter("unclustered-selected", filter);
    }
  }
  window.addEventListener("tk:selected-kiosk", (e) => {
    const id = (e as CustomEvent<{ id: string | null }>).detail?.id ?? null;
    setSelectedKiosk(id);
  });

  map.on("load", () => {
    addKioskLayers();

    map.on("click", "summary-bubble", (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const bbox = (f.properties as { bbox?: number[] }).bbox;
      if (bbox && bbox.length === 4) {
        map.fitBounds(
          [
            [bbox[0]!, bbox[1]!],
            [bbox[2]!, bbox[3]!],
          ],
          { duration: 600, padding: 40, essential: true },
        );
      } else {
        map.easeTo({ center: f.geometry.coordinates as [number, number], zoom: DETAIL_ZOOM + 1 });
      }
    });
    map.on("mouseenter", "summary-bubble", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "summary-bubble", () => (map.getCanvas().style.cursor = ""));

    map.on("click", "clusters", async (e: MapLayerMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
      const clusterId = features[0]?.properties?.["cluster_id"];
      if (clusterId === undefined) return;
      const source = map.getSource("kiosks") as GeoJSONSource;
      const zoom = await source.getClusterExpansionZoom(clusterId as number);
      const geom = features[0]?.geometry;
      if (geom?.type !== "Point") return;
      map.easeTo({ center: geom.coordinates as [number, number], zoom });
    });

    map.on("click", "unclustered", (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const id = (f.properties as { id?: string })?.id;
      if (!id) return;
      // The sheet controller (client/sheet.ts) listens for this event and
      // opens /k/:id in the slide-over panel. Falls back to a full nav if
      // the listener isn't installed for any reason (e.g. JS error on init).
      const ev = new CustomEvent("tk:open-kiosk", {
        detail: { id },
        cancelable: true,
      });
      if (!window.dispatchEvent(ev)) return;
      // dispatchEvent returns true if not preventDefault'd — and the sheet
      // module doesn't call preventDefault. If we wanted a true fallback
      // path, we'd need to detect the listener differently. Practically, the
      // listener is always there on the map page, so just do nothing here.
    });

    map.on("mouseenter", "clusters", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "clusters", () => (map.getCanvas().style.cursor = ""));
    map.on("mouseenter", "unclustered", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "unclustered", () => (map.getCanvas().style.cursor = ""));

    void refresh(map);
  });

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  map.on("moveend", () => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const b = map.getBounds();
      const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
      window.dispatchEvent(new CustomEvent("tk:bbox-changed", { detail: { bbox } }));
      // Persist viewport to URL so refresh / share / browser-back preserves
      // the user's position. replaceState (not pushState) — we don't want
      // every pan to bloat the back-button stack.
      const center = map.getCenter();
      const u = new URL(location.href);
      u.searchParams.set("c", `${center.lat.toFixed(5)},${center.lng.toFixed(5)}`);
      u.searchParams.set("z", map.getZoom().toFixed(2));
      history.replaceState(null, "", u.toString());
      void refresh(map);
    }, 200);
  });

  window.addEventListener("tk:filters-changed", () => void refresh(map));

  // List-item click → fly to the kiosk. Padding keeps the focused point in
  // the visible map area: on desktop the sheet covers the right ~448px;
  // on mobile it covers the bottom ~90% so we leave the marker near the top.
  window.addEventListener("tk:focus-kiosk", (ev) => {
    const { lng, lat } = (ev as CustomEvent<{ lng: number; lat: number }>).detail;
    const desktop = window.matchMedia("(min-width: 640px)").matches;
    // Zoom past clusterMaxZoom (15) so the focused kiosk renders as an
    // individual dot — selecting one from the list and seeing a cluster
    // is a UX no-op.
    map.flyTo({
      center: [lng, lat],
      zoom: Math.max(map.getZoom(), 16),
      padding: desktop ? { right: 448 } : { bottom: Math.round(window.innerHeight * 0.55) },
      duration: 600,
      essential: true,
    });
  });

  // Theme toggle in app.entry.ts dispatches this; rebuild the style with the
  // matching flavor + sprite, then re-add our kiosk source/layers on the new
  // style. setStyle's `diff: false` ensures a clean swap; we own the markers.
  window.addEventListener("tk:theme-changed", () => {
    const next = resolveStyle(mount);
    map.setStyle(next, { diff: false });
  });

  // Whenever the style finishes loading (initial load *and* every setStyle),
  // make sure our custom source + layers are present and repopulated.
  map.on("style.load", () => {
    addKioskLayers();
    void refresh(map);
  });
}

async function fitToUserAndNearest(map: MlMap, lat: number, lng: number): Promise<void> {
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
    const nearest = (await resp.json()) as { lng: number; lat: number; distance: number };

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

async function refresh(map: MlMap): Promise<void> {
  const summaryPromise = loadSummary()
    .then((c) => {
      const s = map.getSource("kiosks-summary") as GeoJSONSource | undefined;
      s?.setData(c);
    })
    .catch(() => {});

  const b = map.getBounds();
  const view: BBox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const zoom = map.getZoom();
  if (zoom < DETAIL_ZOOM) {
    // Below the detail threshold the cluster layers are hidden, but we still
    // clear the detail source so a later zoom-in doesn't briefly flash stale
    // markers from the previous viewport.
    const detail = map.getSource("kiosks") as GeoJSONSource | undefined;
    detail?.setData({ type: "FeatureCollection", features: [] });
    await summaryPromise;
    return;
  }

  try {
    const features = await detailFeaturesForView(view);
    const filter = parseFilterFromQuery(new URLSearchParams(location.search));
    const filtered: FeatureCollection = applyFilters(features, filter);
    const detail = map.getSource("kiosks") as GeoJSONSource | undefined;
    detail?.setData(filtered);
  } catch {
    // Network hiccups are non-fatal — next moveend retries.
  }
  await summaryPromise;
}
