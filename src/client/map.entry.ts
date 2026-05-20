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
import "maplibre-gl/dist/maplibre-gl.css";
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
  // Center on Frankfurt-am-Main by default; bbox attribute is parsed but
  // currently only used as a fallback if center/zoom are missing.
  const map = new maplibregl.Map({
    container: mount,
    style: resolveStyle(mount),
    center: [8.6821, 50.1109],
    zoom: 12,
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

  map.on("load", () => {
    map.addSource("kiosks", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterMaxZoom: 15,
      clusterRadius: 48,
    });

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
        "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
        "text-size": 12,
      },
      paint: {
        "text-color": "#0A0A0A",
      },
    });

    map.addLayer({
      id: "unclustered",
      type: "circle",
      source: "kiosks",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": "#FF2D6F",
        "circle-stroke-color": "#0A0A0A",
        "circle-stroke-width": 1,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 6, 18, 10],
        "circle-opacity": 0.95,
      },
    });

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
      if (id) window.location.href = `/k/${id}`;
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
      void refresh(map);
    }, 200);
  });

  window.addEventListener("tk:filters-changed", () => void refresh(map));
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
