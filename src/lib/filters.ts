/**
 * Query-string ⇄ structured filter conversion. Applied post-SELECT in JS
 * rather than in SQL because (a) `open_now` needs `opening_hours.js` to evaluate
 * and (b) at our scale (< 10k rows nationally) the JS pass is microseconds.
 */

import type { KioskRecord } from "./db";
import { computeStatus } from "./opening-hours";

export interface KioskFilter {
  tags: string[];
  payment: { cards?: boolean; contactless?: boolean; cash?: boolean };
  openNow: boolean;
  q?: string;
}

export const EMPTY_FILTER: KioskFilter = {
  tags: [],
  payment: {},
  openNow: false,
};

/** Stable string used as a cache-key suffix. Empty filter → empty string. */
export function filterSignature(f: KioskFilter): string {
  const parts: string[] = [];
  if (f.tags.length) parts.push(`t=${[...f.tags].sort().join(",")}`);
  if (f.payment.cards) parts.push("p=cards");
  if (f.payment.contactless) parts.push("p=contactless");
  if (f.payment.cash) parts.push("p=cash");
  if (f.openNow) parts.push("o=1");
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
  };
  const q = qs.get("q")?.trim();
  if (q) f.q = q;
  return f;
}

/** Apply filters in JS to a candidate set fetched from D1. */
export function applyFilters(records: KioskRecord[], f: KioskFilter, now = new Date()): KioskRecord[] {
  if (
    f.tags.length === 0 &&
    !f.payment.cards &&
    !f.payment.contactless &&
    !f.payment.cash &&
    !f.openNow &&
    !f.q
  ) {
    return records;
  }

  const q = f.q?.toLowerCase();

  return records.filter((r) => {
    if (q) {
      const haystack = `${r.name} ${r.description ?? ""} ${r.address["street"] ?? ""} ${r.address["district"] ?? ""}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (f.tags.length) {
      const set = new Set(r.tags);
      for (const t of f.tags) if (!set.has(t)) return false;
    }
    if (f.payment.cards && r.payment?.["cards"] !== "yes") return false;
    if (f.payment.contactless && r.payment?.["contactless"] !== "yes") return false;
    if (f.payment.cash && r.payment?.["cash"] !== "yes") return false;
    if (f.openNow) {
      const s = computeStatus(r.hours?.raw, now);
      if (s.kind !== "open") return false;
    }
    return true;
  });
}
