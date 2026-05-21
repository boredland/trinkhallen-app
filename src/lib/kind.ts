/**
 * Shared classifier for "what kind of place is this kiosk really?".
 *
 * The dataset's `shop=kiosk`/`shop=beverages` Overpass filter catches a small
 * number of OSM nodes that are actually pure vending machines or gas-station
 * shops. We don't want to drop them from the dataset — third parties consume
 * the GeoJSON — but on the map we render them differently or hide them
 * outright so the Späti experience stays focused.
 *
 * Long-term, the OSM scrape should capture the canonical signals
 * (`amenity=fuel`, `vending=*`, `self_service=only`) into structured tags;
 * for now we infer from the name. Conservative patterns — a missed
 * classification renders the previous (default-kiosk) behaviour; a
 * false-positive would silently hide a real Späti, which is worse.
 */

export type KioskKind = "kiosk" | "gas_station" | "vending";

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

export function classifyKind(name: string | null | undefined): KioskKind {
  const n = (name ?? "").trim();
  if (!n) return "kiosk";
  for (const p of VENDING_PATTERNS) if (p.test(n)) return "vending";
  for (const p of GAS_STATION_PATTERNS) if (p.test(n)) return "gas_station";
  return "kiosk";
}
