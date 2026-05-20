import type { Env } from "../env";

const TILE_FILENAME = "de.pmtiles";

/**
 * Cheap server-side check: does the R2 bucket actually have a PMTiles file?
 * Result is cached at the edge via the Cache API so subsequent renders
 * don't pay the R2 head() roundtrip.
 *
 * When the bucket is empty we fall back to OSM raster, so the site stays
 * functional before / between PMTiles uploads.
 */
export async function pmtilesAvailable(env: Env, ctx: ExecutionContext): Promise<boolean> {
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`https://cache.trinkhallen.app/_pmtiles-available?v=1`);
  const cached = await cache.match(cacheKey);
  if (cached) return (await cached.text()) === "1";

  const obj = await env.TILES.head(TILE_FILENAME);
  const available = obj !== null;

  const resp = new Response(available ? "1" : "0", {
    headers: { "cache-control": "public, max-age=60" },
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return available;
}

export const PMTILES_URL_PATH = `/tiles/${TILE_FILENAME}`;
