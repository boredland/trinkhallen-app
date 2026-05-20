/**
 * Build a MapLibre style at runtime, choosing vector PMTiles (Protomaps
 * `BLACK` flavor + a few Späti Neon overrides) when available, or falling
 * back to the static OSM-raster `/style-night.json` when R2 is empty.
 *
 * Why client-side: @protomaps/basemaps ships an opinionated layer set that's
 * easier to author in JS than to serialise into a static JSON. Building the
 * style object once at page-load is a few KB of compute, then MapLibre owns it.
 */

import { layers, namedFlavor } from "@protomaps/basemaps";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";

const NEON_PINK = "#FF2D6F";

export type Theme = "dark" | "light";

let protocolRegistered = false;

export function ensurePmtilesProtocol(): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  protocolRegistered = true;
}

export function currentTheme(): Theme {
  const ds = document.documentElement.dataset["theme"];
  if (ds === "light" || ds === "dark") return ds;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function buildVectorStyle(
  pmtilesUrl: string,
  theme: Theme = "dark",
  lang = "de",
): StyleSpecification {
  const flavor = theme === "light" ? lightFlavor() : darkFlavor();
  const spriteVariant = theme === "light" ? "light" : "dark";

  return {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: `https://protomaps.github.io/basemaps-assets/sprites/v4/${spriteVariant}`,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${pmtilesUrl}`,
        attribution:
          '<a href="https://protomaps.com" target="_blank">Protomaps</a> · <a href="https://openstreetmap.org" target="_blank">OpenStreetMap</a>',
      },
    },
    // @protomaps/basemaps' layers() already emits a `background` layer using
    // `flavor.background`; don't prepend our own or MapLibre rejects the
    // duplicate id and the whole style fails to load.
    layers: layers("protomaps", flavor, { lang }),
  } as StyleSpecification;
}

function darkFlavor() {
  const f = { ...namedFlavor("black") };
  // Warm up the pure black so the basemap sits next to our #0A0A0A surfaces
  // without a visible seam.
  f.background = "#0A0A0A";
  f.earth = "#0F0F0F";
  f.water = "#0a131c";
  // Roads with a faint magenta cast — subtle, full-neon would shred legibility.
  f.highway = "#3a2230";
  f.major = "#2a1822";
  f.minor_a = "#1a1216";
  f.minor_b = "#1a1216";
  f.boundaries = "#332229";
  f.buildings = "#161616";
  // Labels in warm off-white so dark backdrops don't lose them.
  f.city_label = "#A8A39A";
  f.country_label = "#F5F2EC";
  f.state_label = "#A8A39A";
  f.roads_label_major = "#6B6862";
  f.roads_label_minor = "#3A3A3A";
  return f;
}

function lightFlavor() {
  const f = { ...namedFlavor("light") };
  // Warm off-white background matches our light-theme surface palette.
  f.background = "#F5F2EC";
  f.earth = "#EDE9E0";
  f.water = "#C4CECE";
  f.buildings = "#E0D9CC";
  // Magenta-tinted boundary so the brand still bleeds through in light mode.
  f.boundaries = "#C8B3BC";
  // Roads a touch warmer than default Protomaps light.
  f.highway = "#EAD7C0";
  f.major = "#EFE2CD";
  f.minor_a = "#F5EFE2";
  f.minor_b = "#F5EFE2";
  // Labels — dark warm so they read well on the off-white earth.
  f.city_label = "#3A3A3A";
  f.country_label = "#0A0A0A";
  f.state_label = "#6B6862";
  f.roads_label_major = "#4A4A4A";
  f.roads_label_minor = "#7A7A7A";
  return f;
}

export const RASTER_FALLBACK_STYLE = "/style-night.json";

/**
 * Resolve which style to apply based on a mount element's `data-tiles` attr
 * and the current theme on `<html data-theme>`.
 */
export function resolveStyle(mount: HTMLElement): StyleSpecification | string {
  const mode = mount.dataset["tiles"] ?? "raster";
  if (mode === "pmtiles") {
    ensurePmtilesProtocol();
    const url = mount.dataset["pmtilesUrl"] ?? "https://tiles.trinkhallen.app/de.pmtiles";
    return buildVectorStyle(url, currentTheme());
  }
  return RASTER_FALLBACK_STYLE;
}

export const ACCENT = NEON_PINK;
