/**
 * Mini map for picking coordinates on /add. Click anywhere on the map to drop
 * a pin and populate the form's lat/lng inputs.
 *
 * Kept separate from `map.entry.ts` so /add doesn't pay for clustering /
 * data-fetch code it doesn't use. Rollup deduplicates the MapLibre chunk
 * between the two entries.
 */

import maplibregl, {
  type GeoJSONSource,
  type Map as MlMap,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const mount = document.getElementById("pick-map");
if (mount instanceof HTMLElement) {
  const latInput = document.querySelector("input[name=lat]") as HTMLInputElement | null;
  const lngInput = document.querySelector("input[name=lng]") as HTMLInputElement | null;
  const initialLat = parseFloat(latInput?.value ?? "");
  const initialLng = parseFloat(lngInput?.value ?? "");
  const hasInitial = Number.isFinite(initialLat) && Number.isFinite(initialLng);

  const map = new maplibregl.Map({
    container: mount,
    style: "/style-night.json",
    center: hasInitial ? [initialLng, initialLat] : [8.6821, 50.1109],
    zoom: hasInitial ? 16 : 11,
    minZoom: 5,
    maxZoom: 19,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: false,
      showAccuracyCircle: false,
    }),
    "top-right",
  );

  map.on("load", () => {
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
        "circle-color": "#FF2D6F",
        "circle-stroke-color": "#0A0A0A",
        "circle-stroke-width": 2,
      },
    });
  });

  map.on("click", (e: MapMouseEvent) => {
    setPin(map, [e.lngLat.lng, e.lngLat.lat], latInput, lngInput);
  });

  map.on("geolocate", (e: { coords: GeolocationCoordinates }) => {
    setPin(map, [e.coords.longitude, e.coords.latitude], latInput, lngInput);
  });
}

function setPin(
  map: MlMap,
  coords: [number, number],
  latInput: HTMLInputElement | null,
  lngInput: HTMLInputElement | null,
): void {
  const src = map.getSource("pin") as GeoJSONSource | undefined;
  src?.setData(pinFeature(coords));
  if (latInput) latInput.value = coords[1].toFixed(6);
  if (lngInput) lngInput.value = coords[0].toFixed(6);
}

function pinFeature(coords: [number, number] | null): GeoJSON.FeatureCollection {
  if (!coords) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: {} }],
  };
}
