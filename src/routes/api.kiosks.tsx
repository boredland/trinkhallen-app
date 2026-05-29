import { Hono } from "hono";
import { KioskList } from "../components/KioskList";
import type { Env } from "../env";
import {
  findNearbyKiosks,
  findNearestKiosk,
  getKioskById,
  queryKiosksInBbox,
} from "../lib/asset-kiosks";
import type { KioskRecord } from "../lib/db";
import {
  applyFilters,
  filterSignature,
  isFilterActive,
  parseFilterFromQuery,
} from "../lib/filters";
import { haversineMeters, parseBbox, parseLatLng, quantizeBbox } from "../lib/geo";
import { pathForLang, resolveLang } from "../lib/messages";
import { buildNavigateTargets } from "../lib/navigate";
import { computeStatus, kioskLocation } from "../lib/opening-hours";

export const apiKiosks = new Hono<{ Bindings: Env }>();

/**
 * GET /api/kiosks?bbox=west,south,east,north
 *
 * Returns a GeoJSON FeatureCollection of kiosks inside the bbox. The response
 * is cached in `caches.default` keyed by a quantized bbox (~1 km grid), so
 * adjacent pans hit cache. TTL is short (60 s) — sync events invalidate by
 * purging the cache namespace.
 */
apiKiosks.get("/api/kiosks", async (c) => {
  const bbox = parseBbox(c.req.query("bbox"));
  if (!bbox) return c.json({ error: "bbox required as ?bbox=w,s,e,n" }, 400);

  const limit = clamp(parseInt(c.req.query("limit") ?? "5000", 10), 1, 10000);
  const filter = parseFilterFromQuery(new URL(c.req.url).searchParams);
  const sig = filterSignature(filter);

  const qb = quantizeBbox(bbox, 0.01);
  const cacheKey = new Request(
    `https://cache.trinkhallen.app/kiosks?b=${qb.west},${qb.south},${qb.east},${qb.north}&l=${limit}&f=${sig}`,
    { method: "GET" },
  );
  const cache = (caches as unknown as { default: Cache }).default;
  // Filter signature changes invalidate; open_now changes minute-by-minute,
  // so we skip cache for it.
  const cacheable = !filter.openNow;
  if (cacheable) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const records = applyFilters(await queryKiosksInBbox(c.env, bbox, limit), filter);
  const body = JSON.stringify(toFeatureCollection(records));
  const resp = new Response(body, {
    headers: {
      "content-type": "application/geo+json; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=60",
    },
  });
  if (cacheable) c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
});

/**
 * HTML fragment of the side panel for the current bbox + filters.
 * Targeted via HTMX from filter chips and the map's moveend handler.
 */
apiKiosks.get("/api/kiosks/panel", async (c) => {
  const url = new URL(c.req.url);
  // The host page bakes ?lang into data-panel-url so partials match its locale;
  // Accept-Language is only the fallback for a bare fetch.
  const lang = resolveLang(url.searchParams.get("lang") ?? c.req.header("accept-language"));
  const bbox = parseBbox(url.searchParams.get("bbox"));
  const origin = parseLatLng(url.searchParams.get("origin"));
  if (!bbox)
    return c.html(
      <KioskList lang={lang} kiosks={[]} totalInBbox={0} filteredCount={0} userAgent={null} />,
    );
  const filter = parseFilterFromQuery(url.searchParams);
  const all = await queryKiosksInBbox(c.env, bbox, 5000);
  const filtered = applyFilters(all, filter);
  if (origin) {
    filtered.sort(
      (a, b) =>
        haversineMeters(origin, { lat: a.lat, lng: a.lng }) -
        haversineMeters(origin, { lat: b.lat, lng: b.lng }),
    );
  } else {
    filtered.sort((a, b) => a.name.localeCompare(b.name, "de"));
  }
  const now = new Date();
  const openNowCount = filtered.reduce(
    (n, r) => (computeStatus(r.hours?.raw, now, kioskLocation(r)).kind === "open" ? n + 1 : n),
    0,
  );
  return c.html(
    <KioskList
      lang={lang}
      kiosks={filtered.slice(0, 100)}
      totalInBbox={all.length}
      filteredCount={filtered.length}
      openNowCount={openNowCount}
      filterActive={isFilterActive(filter)}
      resetHref={pathForLang("/", lang)}
      origin={origin ?? undefined}
      userAgent={c.req.header("user-agent") ?? null}
    />,
  );
});

/**
 * GET /api/kiosks/nearest?origin=lat,lng
 *
 * Returns the closest kiosk to the given point, with distance in meters.
 * Used by the geolocate flow on the map page to fitBounds the user + their
 * nearest kiosk so the zoom-in lands as close as possible while still
 * keeping the nearest marker visible.
 *
 * O(n) scan — for ~2k rows it's microseconds. If the dataset grows past
 * the 10k mark we should add a spatial pre-filter (e.g. R-tree) or
 * SQLite's `R*Tree` virtual table.
 */
apiKiosks.get("/api/kiosks/nearest", async (c) => {
  const origin = parseLatLng(c.req.query("origin"));
  if (!origin) return c.json({ error: "origin lat,lng required" }, 400);

  const hit = await findNearestKiosk(c.env, origin);
  if (!hit) return c.json({ error: "no kiosks in dataset" }, 404);

  return c.json(
    {
      id: hit.record.id,
      name: hit.record.name,
      lng: hit.record.lng,
      lat: hit.record.lat,
      distance: hit.distance,
    },
    200,
    { "cache-control": "public, max-age=30, s-maxage=30" },
  );
});

/**
 * GET /api/kiosks/nearest-open?origin=lat,lng
 *
 * Picks the closest non-vending kiosk with computeStatus().kind === "open"
 * out of a ~5 km radius around the user. Used by the /jetzt shortcut to
 * deep-link straight into a native Maps app. Returns the kiosk id + a
 * UA-appropriate navigation URL; client only needs to `window.location` to it.
 */
apiKiosks.get("/api/kiosks/nearest-open", async (c) => {
  const origin = parseLatLng(c.req.query("origin"));
  if (!origin) return c.json({ error: "origin lat,lng required" }, 400);

  // Pull a generous candidate pool — open-now is sparse on holidays and at
  // night, so we'd rather walk a bit farther than miss the only open Späti.
  const candidates = await findNearbyKiosks(c.env, origin, "", 50);
  const now = new Date();
  const openHit = candidates.find(
    (h) => computeStatus(h.record.hours?.raw, now, kioskLocation(h.record)).kind === "open",
  );
  if (!openHit) return c.json({ error: "no open kiosks within reach" }, 404);

  const nav = buildNavigateTargets({
    name: openHit.record.name,
    lat: openHit.record.lat,
    lng: openHit.record.lng,
    userAgent: c.req.header("user-agent") ?? null,
  });
  return c.json(
    {
      id: openHit.record.id,
      name: openHit.record.name,
      lng: openHit.record.lng,
      lat: openHit.record.lat,
      distance: openHit.distance,
      nav_url: nav.primary.href,
      detail_url: `/k/${openHit.record.id}`,
    },
    200,
    { "cache-control": "private, max-age=30" },
  );
});

apiKiosks.get("/api/kiosks/:id", async (c) => {
  const id = c.req.param("id");
  const record = await getKioskById(c.env, id);
  if (!record) return c.json({ error: "not found" }, 404);
  return c.json({ ...toFeature(record), aggregate: null });
});

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function toFeature(r: KioskRecord) {
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [r.lng, r.lat] },
    properties: {
      id: r.id,
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      address: r.address,
      ...(r.hours ? { hours: r.hours } : {}),
      tags: r.tags,
      ...(r.payment ? { payment: r.payment } : {}),
      ...(r.sources ? { sources: r.sources } : {}),
    },
  };
}

function toFeatureCollection(records: KioskRecord[]) {
  return {
    type: "FeatureCollection" as const,
    features: records.map(toFeature),
  };
}
