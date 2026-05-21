/**
 * Shared classifier for "is this kiosk actually a vending machine?".
 *
 * The `shop=kiosk`/`shop=beverages` Overpass filter catches some OSM nodes
 * that are actually pure vending machines (JIMA, Sielaff, "Automaten-Kiosk").
 * Trinkhallen-data's scrape attaches `properties.kind = "vending_machine"`
 * when the canonical OSM tags (`amenity=vending_machine`, `self_service=only`,
 * `automated=yes`) say so; everything else falls back to a conservative
 * name regex.
 *
 * Returning `"vending"` causes the feature to be hidden from collection
 * views (map, sidebar, nearest-kiosk). `/k/:id` deep links still load.
 */

export type KioskKind = "kiosk" | "vending";

interface ClassifyInput {
  name?: string | null;
  /** Set by the data pipeline (trinkhallen-data) from canonical OSM tags. */
  dataKind?: string | null;
}

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

  if (obj.dataKind === "vending_machine") return "vending";

  const n = (obj.name ?? "").trim();
  if (!n) return "kiosk";
  for (const p of VENDING_PATTERNS) if (p.test(n)) return "vending";
  return "kiosk";
}
