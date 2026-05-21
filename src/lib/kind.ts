/**
 * Shared classifier for "what kind of place is this kiosk really?".
 *
 * The dataset's `shop=kiosk`/`shop=beverages` Overpass filter catches a small
 * number of OSM nodes that are actually pure vending machines or gas-station
 * shops. We don't want to drop them from the dataset — third parties consume
 * the GeoJSON — but on the map we render them differently or hide them
 * outright so the Späti experience stays focused.
 *
 * Two-tier classification:
 *   1. Read `properties.kind` if the data layer already classified the
 *      feature (trinkhallen-data PR #19 + osm-to-geojson.ts detectKind()
 *      from canonical OSM tags `amenity=vending_machine`, `self_service=only`,
 *      `automated=yes`).
 *   2. Otherwise, fall back to name regex — catches features whose OSM
 *      tags don't carry the disambiguating signals and the gas-station
 *      category, which OSM doesn't tag consistently.
 *
 * Conservative patterns — a missed classification renders the previous
 * (default-kiosk) behaviour; a false-positive would silently hide a real
 * Späti, which is worse.
 */

export type KioskKind = "kiosk" | "gas_station" | "vending";

interface ClassifyInput {
  name?: string | null;
  /** Set by the data pipeline (trinkhallen-data) from canonical OSM tags. */
  dataKind?: string | null;
}

const GAS_STATION_PATTERNS = [
  /\btankstelle\b/i,
  /\bautohof\b/i,
  /\baral\b/i,
  /\bshell\b/i,
  /\besso\b/i,
  /\btotal\b/i,
  /\b(bp|jet|omv|hem|agip|avia|q1)\b/i,
  /\bstar\s+tankstelle\b/i,
];

const VENDING_PATTERNS = [
  /^jima$/i,
  /\bselecta\b/i,
  /\bsielaff\b/i,
  /\bvending\s+machines?\b/i,
  /\bautomaten[-\s]*kiosk\b/i,
  /\bautomaten[-\s]*shop\b/i,
];

export function classifyKind(input: ClassifyInput | string | null | undefined): KioskKind {
  const obj: ClassifyInput =
    typeof input === "string" || input == null ? { name: input ?? "" } : input;

  // Tier 1: the data layer's signal wins when present.
  if (obj.dataKind === "vending_machine") return "vending";

  // Tier 2: name regex.
  const n = (obj.name ?? "").trim();
  if (!n) return "kiosk";
  for (const p of VENDING_PATTERNS) if (p.test(n)) return "vending";
  for (const p of GAS_STATION_PATTERNS) if (p.test(n)) return "gas_station";
  return "kiosk";
}
