/**
 * Query-string ⇄ structured filter conversion. Applied post-SELECT in JS
 * rather than in SQL because (a) `open_now` needs `opening_hours.js` to evaluate
 * and (b) at our scale (< 10k rows nationally) the JS pass is microseconds.
 */

import Fuse from "fuse.js";
import type { KioskRecord } from "./db";
import { computeStatus } from "./opening-hours";

export interface KioskFilter {
  tags: string[];
  payment: { cards?: boolean; contactless?: boolean; cash?: boolean };
  openNow: boolean;
  /** Kiosks missing opening hours — surfaces gaps for users to help fill in. */
  needsHours: boolean;
  q?: string;
}

export const EMPTY_FILTER: KioskFilter = {
  tags: [],
  payment: {},
  openNow: false,
  needsHours: false,
};

/** Stable string used as a cache-key suffix. Empty filter → empty string. */
export function filterSignature(f: KioskFilter): string {
  const parts: string[] = [];
  if (f.tags.length) parts.push(`t=${[...f.tags].sort().join(",")}`);
  if (f.payment.cards) parts.push("p=cards");
  if (f.payment.contactless) parts.push("p=contactless");
  if (f.payment.cash) parts.push("p=cash");
  if (f.openNow) parts.push("o=1");
  if (f.needsHours) parts.push("nh=1");
  if (f.q) parts.push(`q=${f.q.toLowerCase()}`);
  return parts.join("&");
}

export function parseFilterFromQuery(qs: URLSearchParams): KioskFilter {
  const splitCsv = (raw: string | null): string[] =>
    raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const pay = new Set(splitCsv(qs.get("pay")));
  const f: KioskFilter = {
    tags: splitCsv(qs.get("tags")).map((t) => t.toLowerCase()),
    payment: {
      cards: pay.has("cards"),
      contactless: pay.has("contactless"),
      cash: pay.has("cash"),
    },
    openNow: qs.get("open_now") === "1" || qs.get("open_now") === "true",
    needsHours: qs.get("needs_hours") === "1" || qs.get("needs_hours") === "true",
  };
  const q = qs.get("q")?.trim();
  if (q) f.q = q;
  return f;
}

/**
 * Normalise common German variants — German users often type ASCII versions
 * (oe/ue/ae/ss) of umlaut/eszett. Apply on both sides of the comparison so
 * "wirtshausl" can match "Würtshausl", "applewoi" can match "Äppler", etc.
 */
function normalizeDe(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[`'']/g, "");
}

/** Apply filters in JS to a candidate set fetched from D1. */
export function applyFilters(
  records: KioskRecord[],
  f: KioskFilter,
  now = new Date(),
): KioskRecord[] {
  if (
    f.tags.length === 0 &&
    !f.payment.cards &&
    !f.payment.contactless &&
    !f.payment.cash &&
    !f.openNow &&
    !f.needsHours &&
    !f.q
  ) {
    return records;
  }

  let candidates = records;

  // Apply fuzzy text search first so it shapes the candidate set the cheaper
  // structured filters then prune further.
  if (f.q) {
    const fuse = new Fuse(records, {
      keys: [
        { name: "name", weight: 0.5, getFn: (r) => normalizeDe(r.name) },
        { name: "description", weight: 0.15, getFn: (r) => normalizeDe(r.description ?? "") },
        { name: "street", weight: 0.15, getFn: (r) => normalizeDe(r.address["street"] ?? "") },
        { name: "city", weight: 0.05, getFn: (r) => normalizeDe(r.address["city"] ?? "") },
        { name: "district", weight: 0.1, getFn: (r) => normalizeDe(r.address["district"] ?? "") },
        { name: "tags", weight: 0.05, getFn: (r) => r.tags.map(normalizeDe).join(" ") },
      ],
      threshold: 0.35, // 0 = exact, 1 = match anything
      ignoreLocation: true, // don't favour matches near the start
      minMatchCharLength: 2,
    });
    candidates = fuse.search(normalizeDe(f.q)).map((res) => res.item);
  }

  return candidates.filter((r) => {
    if (f.tags.length) {
      const set = new Set(r.tags);
      for (const t of f.tags) if (!set.has(t)) return false;
    }
    // "Karte" chip toggles `cards` only, but we treat cards + contactless as
    // a single "can I pay without cash" bucket — match a kiosk that accepts
    // either signal. Older URLs with `pay=contactless` still work (same
    // semantics).
    if (f.payment.cards || f.payment.contactless) {
      if (r.payment?.["cards"] !== "yes" && r.payment?.["contactless"] !== "yes") return false;
    }
    if (f.payment.cash && r.payment?.["cash"] !== "yes") return false;
    if (f.openNow) {
      const s = computeStatus(r.hours?.raw, now);
      if (s.kind !== "open") return false;
    }
    if (f.needsHours && r.hours?.raw) return false;
    return true;
  });
}

/** True iff the filter has any active constraint. Drives the UI's reset CTA. */
export function isFilterActive(f: KioskFilter): boolean {
  return (
    f.tags.length > 0 ||
    !!f.payment.cards ||
    !!f.payment.contactless ||
    !!f.payment.cash ||
    f.openNow ||
    f.needsHours ||
    !!f.q
  );
}
