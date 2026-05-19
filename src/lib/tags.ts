/**
 * Display labels for tag slugs. Slugs whose title-cased form already reads
 * correctly aren't listed here — `tagLabel("snacks")` → `"Snacks"` via the
 * fallback. Override map below covers German-specific cases.
 *
 * Keep in sync with `schema/tags.json` in the trinkhallen-data repo.
 */

const OVERRIDES: Record<string, string> = {
  applewoi: "Äppler",
  fritz_kola: "fritz-kola",
  gemischte_tuete: "Gemischte Tüte",
  ueberdacht: "Überdacht",
  draussen: "Draußen",
  gemuetlich: "Gemütlich",
  wohnzimmer: "Wie ein Wohnzimmer",
  craft_bier: "Craft-Bier",
  raucherbereich: "Raucherbereich",
  barrierefrei: "Barrierefrei",
  sonne: "Sonnig",
};

export function tagLabel(slug: string): string {
  return OVERRIDES[slug] ?? titlecase(slug);
}

function titlecase(slug: string): string {
  return slug
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => (w.length ? w[0]!.toUpperCase() + w.slice(1) : ""))
    .join(" ");
}
