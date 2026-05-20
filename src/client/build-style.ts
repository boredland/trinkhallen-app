/**
 * Build a MapLibre style at runtime, choosing vector PMTiles (Protomaps
 * `BLACK` flavor + a few Späti Neon overrides) when available, or falling
 * back to the static OSM-raster `/style-night.json` when R2 is empty.
 *
 * Why client-side: @protomaps/basemaps ships an opinionated layer set that's
 * easier to author in JS than to serialise into a static JSON. Building the
 * style object once at page-load is a few KB of compute, then MapLibre owns it.
 */

import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { Protocol } from "pmtiles";

// Späti Neon overrides — minimal tweaks to make the Protomaps BLACK flavor
// feel like ours rather than generic Protomaps black.
const NEON_PINK = "#FF2D6F";

let protocolRegistered = false;

export function ensurePmtilesProtocol(): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  protocolRegistered = true;
}

export function buildVectorStyle(pmtilesUrl: string, lang = "de"): StyleSpecification {
  const flavor = { ...namedFlavor("black") };

  // Slight warm-up of the pure black so map gradient sits next to our #0A0A0A
  // surfaces without seam visibility.
  flavor.background = "#0A0A0A";
  flavor.earth = "#0F0F0F";
  flavor.water = "#0a131c";

  // Major roads pop with a faint magenta cast so they read as roads but stay
  // dark. Subtle — full neon would shred legibility.
  flavor.highway = "#3a2230";
  flavor.major = "#2a1822";
  flavor.minor_a = "#1a1216";
  flavor.minor_b = "#1a1216";
  flavor.boundaries = "#332229";
  flavor.buildings = "#161616";

  // Country/city labels in warm fg so dark backdrops don't lose them
  flavor.city_label = "#A8A39A";
  flavor.country_label = "#F5F2EC";
  flavor.state_label = "#A8A39A";
  flavor.roads_label_major = "#6B6862";
  flavor.roads_label_minor = "#3A3A3A";

  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/dark",
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${pmtilesUrl}`,
        attribution: '<a href="https://protomaps.com" target="_blank">Protomaps</a> · <a href="https://openstreetmap.org" target="_blank">OpenStreetMap</a>',
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": flavor.background } },
      ...layers("protomaps", flavor, { lang }),
    ],
  } as StyleSpecification;
}

export const RASTER_FALLBACK_STYLE = "/style-night.json";

/**
 * Resolve which style to apply based on a mount element's `data-tiles` attr.
 * Server decides at render time (with an R2 head() check); client honours it.
 */
export function resolveStyle(mount: HTMLElement): StyleSpecification | string {
  const mode = mount.dataset["tiles"] ?? "raster";
  if (mode === "pmtiles") {
    ensurePmtilesProtocol();
    const url = mount.dataset["pmtilesUrl"] ?? "https://tiles.trinkhallen.app/de.pmtiles";
    return buildVectorStyle(url);
  }
  return RASTER_FALLBACK_STYLE;
}

/** Override the neon-pink accent — used by callers that want a marker colour. */
export const ACCENT = NEON_PINK;
