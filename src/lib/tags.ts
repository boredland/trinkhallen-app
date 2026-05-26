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
  gluecksspiele: "Glücksspiele",
  ueberdacht: "Überdacht",
  draussen: "Draußen",
  gemuetlich: "Gemütlich",
  wohnzimmer: "Wie ein Wohnzimmer",
  craft_bier: "Craft-Bier",
  raucherbereich: "Raucherbereich",
  barrierefrei: "Barrierefrei",
  sonne: "Sonnig",
  wc: "WC",
  sitzgelegenheiten: "Sitzgelegenheiten",
  wlan: "WLAN",
  geldautomat: "Geldautomat",
};

/**
 * Tags the "Warst du hier?" gap-fill form lets a visitor add or remove via
 * `update_tags` reports, grouped the way schema/tags.json groups them so the
 * form can render scannable sub-sections. The server validates incoming
 * add_tags / remove_tags against REPORTABLE_TAGS before persisting a report.
 * Keep slugs + groups in sync with schema/tags.json in the data repo.
 */
export const REPORTABLE_TAG_GROUPS = [
  {
    label: "Sortiment",
    tags: ["backwaren", "eis", "zeitungen", "gemischte_tuete", "gluecksspiele"],
  },
  { label: "Ambiente", tags: ["innenraum", "stehtisch", "ueberdacht"] },
  { label: "Ausstattung", tags: ["wc", "barrierefrei", "paketshop", "wlan", "geldautomat"] },
] as const;

export type ReportableTag = (typeof REPORTABLE_TAG_GROUPS)[number]["tags"][number];

export const REPORTABLE_TAGS: readonly ReportableTag[] = REPORTABLE_TAG_GROUPS.flatMap(
  (g) => g.tags,
);

export function isReportableTag(slug: string): slug is ReportableTag {
  return (REPORTABLE_TAGS as readonly string[]).includes(slug);
}

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
