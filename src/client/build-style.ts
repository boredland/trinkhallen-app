/**
 * MapLibre style URL by theme.
 *
 * We point MapLibre at OpenFreeMap's hosted OpenMapTiles styles
 * (https://openfreemap.org) and let it handle tile + glyph + sprite
 * fetches natively. No PMTiles, no R2 bucket — the map operator burden
 * collapses to "pick a style name".
 */

export type Theme = "dark" | "light";

const STYLE_BY_THEME: Record<Theme, string> = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/positron",
};

export function currentTheme(): Theme {
  const ds = document.documentElement.dataset["theme"];
  if (ds === "light" || ds === "dark") return ds;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Pure URL for the current theme. MapLibre accepts a string style argument
 *  and fetches the rest natively. */
export function resolveStyle(_mount: HTMLElement): string {
  return STYLE_BY_THEME[currentTheme()];
}

export const ACCENT = "#FF2D6F";
