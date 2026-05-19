import { Hono } from "hono";
import type { Env } from "../env";
import { getKioskById, queryKiosksInBbox, type KioskRecord } from "../lib/db";
import { parseBbox, quantizeBbox } from "../lib/geo";

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

  const qb = quantizeBbox(bbox, 0.01);
  const cacheKey = new Request(
    `https://cache.trinkhallen.app/kiosks?b=${qb.west},${qb.south},${qb.east},${qb.north}&l=${limit}`,
    { method: "GET" },
  );
  const cache = (caches as unknown as { default: Cache }).default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const records = await queryKiosksInBbox(c.env.DB, bbox, limit);
  const body = JSON.stringify(toFeatureCollection(records));
  const resp = new Response(body, {
    headers: {
      "content-type": "application/geo+json; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=60",
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
});

apiKiosks.get("/api/kiosks/:id", async (c) => {
  const id = c.req.param("id");
  const record = await getKioskById(c.env.DB, id);
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
