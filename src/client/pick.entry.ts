/**
 * Mini map for picking coordinates on /add. Click anywhere on the map to drop
 * a pin and populate the form's lat/lng inputs.
 *
 * Kept separate from `map.entry.ts` so /add doesn't pay for clustering /
 * data-fetch code it doesn't use. Rollup deduplicates the MapLibre chunk
 * between the two entries.
 */

import maplibregl, { type GeoJSONSource, type MapMouseEvent, type Map as MlMap } from "maplibre-gl";
// maplibre-gl.css is imported from app.entry.ts; see comment there.
import { resolveStyle } from "./build-style";

type AddrInputs = {
  street: HTMLInputElement | null;
  number: HTMLInputElement | null;
  postalcode: HTMLInputElement | null;
  city: HTMLInputElement | null;
};

interface PhotonProperties {
  street?: string;
  housenumber?: string;
  postcode?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
}

const PHOTON_URL = "https://photon.komoot.io/reverse";
const RG_DEBOUNCE_MS = 350;

const mount = document.getElementById("pick-map");
if (mount instanceof HTMLElement) {
  const latInput = document.querySelector("input[name=lat]") as HTMLInputElement | null;
  const lngInput = document.querySelector("input[name=lng]") as HTMLInputElement | null;
  const addrInputs: AddrInputs = {
    street: document.querySelector("input[name=street]"),
    number: document.querySelector("input[name=number]"),
    postalcode: document.querySelector("input[name=postalcode]"),
    city: document.querySelector("input[name=city]"),
  };
  const initialLat = parseFloat(latInput?.value ?? "");
  const initialLng = parseFloat(lngInput?.value ?? "");
  const hasInitial = Number.isFinite(initialLat) && Number.isFinite(initialLng);

  const map = new maplibregl.Map({
    container: mount,
    style: resolveStyle(mount),
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
    map.setStyle(resolveStyle(mount), { diff: false });
  });
  map.on("style.load", () => {
    if (!map.getSource("pin")) {
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
          "circle-stroke-color":
            document.documentElement.dataset["theme"] === "light" ? "#F5F2EC" : "#0A0A0A",
          "circle-stroke-width": 2,
        },
      });
    }
  });

  map.on("click", (e: MapMouseEvent) => {
    setPin(map, [e.lngLat.lng, e.lngLat.lat], latInput, lngInput);
    scheduleReverseGeocode(e.lngLat.lng, e.lngLat.lat, addrInputs);
  });

  map.on("geolocate", (e: { coords: GeolocationCoordinates }) => {
    setPin(map, [e.coords.longitude, e.coords.latitude], latInput, lngInput);
    scheduleReverseGeocode(e.coords.longitude, e.coords.latitude, addrInputs);
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

/**
 * Reverse-geocodes (lng, lat) via Photon and fills the address fields. The
 * call is debounced — every map click re-arms the timer + aborts the
 * in-flight request, so dragging the pin only spends one HTTP round-trip
 * on the final position. Empty fields are filled; user-typed values are
 * never overwritten. Failures are silent — the form remains usable.
 */
let rgTimer: ReturnType<typeof setTimeout> | undefined;
let rgAbort: AbortController | undefined;
function scheduleReverseGeocode(lng: number, lat: number, inputs: AddrInputs): void {
  if (rgTimer) clearTimeout(rgTimer);
  rgAbort?.abort();
  rgTimer = setTimeout(() => {
    rgAbort = new AbortController();
    void reverseGeocode(lng, lat, inputs, rgAbort.signal);
  }, RG_DEBOUNCE_MS);
}

async function reverseGeocode(
  lng: number,
  lat: number,
  inputs: AddrInputs,
  signal: AbortSignal,
): Promise<void> {
  const url = `${PHOTON_URL}?lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&lang=de`;
  let json: { features?: Array<{ properties?: PhotonProperties }> };
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return;
    json = await res.json();
  } catch {
    return;
  }
  const props = json.features?.[0]?.properties;
  if (!props) return;
  fillIfEmpty(inputs.street, props.street);
  fillIfEmpty(inputs.number, props.housenumber);
  fillIfEmpty(inputs.postalcode, props.postcode);
  // Photon labels small German municipalities `town` / `village` rather
  // than `city`. Walk through the candidates by descending specificity.
  fillIfEmpty(inputs.city, props.city ?? props.town ?? props.village ?? props.county);
}

function fillIfEmpty(input: HTMLInputElement | null, value: string | undefined): void {
  if (!input || !value) return;
  if (input.value.trim()) return;
  input.value = value;
}

function pinFeature(coords: [number, number] | null): GeoJSON.FeatureCollection {
  if (!coords) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: {} },
    ],
  };
}
