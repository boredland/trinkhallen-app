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
  type Map as MlMap,
  type MapLayerMouseEvent,
} from "maplibre-gl";
// maplibre-gl.css is imported from app.entry.ts (always loaded) so its
// styles always reach the page; importing here splits into a chunk our
// manifest reader doesn't pull in transitively.
import { resolveStyle } from "./build-style";

interface KioskFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { id: string; name: string; tags?: string[] };
}
interface FeatureCollection {
  type: "FeatureCollection";
  features: KioskFeature[];
}

const mount = document.getElementById("map");
if (mount instanceof HTMLElement) {
  // ?c=lat,lng&z=zoom — restore the previously-saved viewport, e.g. when
  // returning from /k/:id or following a shared link. Defaults to Frankfurt.
  const params = new URL(location.href).searchParams;
  const initialCenter = (() => {
    const c = params.get("c");
    if (!c) return [8.6821, 50.1109] as [number, number];
    const [lat, lng] = c.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat! >= -90 && lat! <= 90 && lng! >= -180 && lng! <= 180) {
      return [lng!, lat!] as [number, number];
    }
    return [8.6821, 50.1109] as [number, number];
  })();
  const initialZoom = (() => {
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
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: false,
      showAccuracyCircle: true,
    }),
    "top-right",
  );

  /** Lazy-load + register the bottle-silhouette icon used by the unclustered
   *  symbol layer.
   *
   *  MapLibre's `map.loadImage()` rejects SVG (it pipes through ImageBitmap
   *  which only handles raster formats), so we rasterise to a canvas at the
   *  pixel ratio we want and hand over the ImageData. Native SDF tinting is
   *  skipped — the icon is self-contained with its own brand colour + stroke. */
  async function ensureKioskIcon(): Promise<void> {
    if (map.hasImage("kiosk-icon")) return;
    const w = 24;
    const h = 32;
    const scale = (window.devicePixelRatio ?? 1) >= 2 ? 2 : 1;
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("kiosk icon failed to load"));
      img.src = "/marker-kiosk.svg";
    });
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, w * scale, h * scale);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    map.addImage("kiosk-icon", data, { pixelRatio: scale });
  }

  /** Add the kiosk source + layers. Idempotent — safe to re-call after a
   *  `map.setStyle()` (which strips custom sources/layers, but `addImage`
   *  registrations survive). */
  async function addKioskLayers(): Promise<void> {
    if (map.getSource("kiosks")) return;
    await ensureKioskIcon();

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
      id: "clusters",
      type: "circle",
      source: "kiosks",
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

    // Low-zoom dot: keeps unclustered markers visible when they're tiny and
    // the bottle icon would just be noise. Fades out as the icon fades in.
    map.addLayer({
      id: "unclustered-dot",
      type: "circle",
      source: "kiosks",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": "#FF2D6F",
        "circle-stroke-color": dotStroke,
        "circle-stroke-width": 1,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 13, 5, 14, 0],
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 12, 1, 14, 0],
      },
    });

    // Bottle icon: scales up at high zoom where the dot would feel small.
    map.addLayer({
      id: "unclustered",
      type: "symbol",
      source: "kiosks",
      filter: ["!", ["has", "point_count"]],
      layout: {
        "icon-image": "kiosk-icon",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 14, 0.9, 18, 1.4],
        "icon-anchor": "bottom",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: {
        "icon-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0, 14, 1],
      },
    });
  }

  map.on("load", () => {
    void addKioskLayers();

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
    void addKioskLayers().then(() => refresh(map));
  });
}

async function refresh(map: MlMap): Promise<void> {
  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const url = new URL("/api/kiosks", location.origin);
  url.searchParams.set("bbox", bbox);
  for (const k of ["pay", "tags", "open_now", "q"]) {
    const v = new URLSearchParams(location.search).get(k);
    if (v) url.searchParams.set(k, v);
  }
  try {
    const resp = await fetch(url.toString(), { headers: { accept: "application/geo+json" } });
    if (!resp.ok) return;
    const collection = (await resp.json()) as FeatureCollection;
    const source = map.getSource("kiosks") as GeoJSONSource | undefined;
    source?.setData(collection);
  } catch {
    // Network hiccups are non-fatal — next moveend retries.
  }
}
