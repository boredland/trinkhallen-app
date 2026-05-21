/**
 * Client-side equivalent of src/lib/filters.ts, operating on GeoJSON features
 * instead of D1 KioskRecord rows.
 *
 * Kept separate (rather than reusing the server filter via a refactor) because
 * the shapes differ — features wrap properties under `properties`, the server
 * row is flat — and the client needs to ship as small a JS bundle as is
 * reasonable. Fuse + opening_hours together are already ~30 KB gzipped, so
 * they're worth importing only here at the map edge.
 */

import Fuse from "fuse.js";
import { computeStatus } from "../lib/opening-hours";
import type { Feature, FeatureCollection } from "./region-store";

export interface ClientFilter {
  tags: string[];
  payment: { cards?: boolean; contactless?: boolean; cash?: boolean };
  openNow: boolean;
  /** Kiosks missing opening hours — surfaces gaps for users to help fill in. */
  needsHours: boolean;
  q?: string;
}

export const EMPTY_FILTER: ClientFilter = {
  tags: [],
  payment: {},
  openNow: false,
  needsHours: false,
};

interface FeatureProps {
  id: string;
  name: string;
  description?: string;
  address?: { street?: string; city?: string; district?: string };
  hours?: { raw?: string };
  tags?: string[];
  payment?: Record<string, "yes" | "no" | "unknown">;
}

export function parseFilterFromQuery(qs: URLSearchParams): ClientFilter {
  const splitCsv = (raw: string | null): string[] =>
    raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const pay = new Set(splitCsv(qs.get("pay")));
  const f: ClientFilter = {
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

export function isFilterActive(f: ClientFilter): boolean {
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

function normalizeDe(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[`'']/g, "");
}

export function applyFilters(
  collection: FeatureCollection,
  f: ClientFilter,
  now = new Date(),
): FeatureCollection {
  if (!isFilterActive(f)) return collection;
  let features = collection.features;

  if (f.q) {
    const fuse = new Fuse(features, {
      keys: [
        {
          name: "name",
          weight: 0.5,
          getFn: (x) => normalizeDe((x.properties as unknown as FeatureProps).name ?? ""),
        },
        {
          name: "description",
          weight: 0.15,
          getFn: (x) => normalizeDe((x.properties as unknown as FeatureProps).description ?? ""),
        },
        {
          name: "street",
          weight: 0.15,
          getFn: (x) =>
            normalizeDe((x.properties as unknown as FeatureProps).address?.street ?? ""),
        },
        {
          name: "city",
          weight: 0.05,
          getFn: (x) => normalizeDe((x.properties as unknown as FeatureProps).address?.city ?? ""),
        },
        {
          name: "district",
          weight: 0.1,
          getFn: (x) =>
            normalizeDe((x.properties as unknown as FeatureProps).address?.district ?? ""),
        },
        {
          name: "tags",
          weight: 0.05,
          getFn: (x) =>
            ((x.properties as unknown as FeatureProps).tags ?? []).map(normalizeDe).join(" "),
        },
      ],
      threshold: 0.35,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
    features = fuse.search(normalizeDe(f.q)).map((res) => res.item);
  }

  const filtered = features.filter((feat: Feature) => {
    const p = feat.properties as unknown as FeatureProps;
    if (f.tags.length) {
      const set = new Set(p.tags ?? []);
      for (const t of f.tags) if (!set.has(t)) return false;
    }
    // Mirror lib/filters.ts: any of cards / contactless / girocard counts
    // toward the "Karte" filter — Girocard is the dominant German signal.
    if (f.payment.cards || f.payment.contactless) {
      if (
        p.payment?.["cards"] !== "yes" &&
        p.payment?.["contactless"] !== "yes" &&
        p.payment?.["girocard"] !== "yes"
      )
        return false;
    }
    if (f.payment.cash && p.payment?.["cash"] !== "yes") return false;
    if (f.openNow) {
      const s = computeStatus(p.hours?.raw, now);
      if (s.kind !== "open") return false;
    }
    if (f.needsHours && p.hours?.raw) return false;
    return true;
  });

  return { type: "FeatureCollection", features: filtered };
}
