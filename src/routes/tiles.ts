/**
 * Range-serves PMTiles (and other binary blobs) out of the `TILES` R2 bucket.
 * MapLibre's `pmtiles://` protocol does HTTP Range requests against this
 * route to fetch directory + tile data without downloading the whole file.
 *
 * Response shape:
 *   - 404 if the object isn't in R2 (lets the front-end fall back to raster)
 *   - 200 with full body when no Range header is present
 *   - 206 with Content-Range when a Range header is present (single-range only;
 *     pmtiles never sends multipart ranges)
 *   - Cache-control immutable for a year because PMTiles filenames are
 *     content-addressed (rebuild → new filename → bump in style URL)
 */

import { Hono } from "hono";
import type { Env } from "../env";

export const tiles = new Hono<{ Bindings: Env }>();

tiles.get("/tiles/:filename", async (c) => {
  const filename = c.req.param("filename");
  if (!/^[\w.-]+\.pmtiles$/.test(filename)) {
    return c.text("invalid filename", 400);
  }

  const range = c.req.header("range");
  const parsed = range ? parseRange(range) : null;

  const opts: R2GetOptions = {};
  if (parsed) {
    opts.range =
      parsed.end !== undefined
        ? { offset: parsed.start, length: parsed.end - parsed.start + 1 }
        : { offset: parsed.start };
  }

  const obj = await c.env.TILES.get(filename, opts);
  if (!obj) return c.text("Not found", 404);

  const headers = new Headers();
  headers.set("accept-ranges", "bytes");
  headers.set("content-type", "application/octet-stream");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "range");

  if (parsed) {
    const start = parsed.start;
    const end = parsed.end ?? obj.size - 1;
    const length = end - start + 1;
    headers.set("content-range", `bytes ${start}-${end}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});

// CORS preflight — MapLibre / pmtiles.js sends a Range header which counts
// as non-simple; some browsers preflight it.
tiles.options("/tiles/:filename", (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "range",
      "access-control-max-age": "86400",
    },
  });
});

interface ParsedRange {
  start: number;
  end?: number;
}

function parseRange(header: string): ParsedRange | null {
  // We only handle a single bytes range — pmtiles never sends multi-range.
  const m = header.match(/^bytes=(\d+)-(\d+)?$/);
  if (!m) return null;
  const start = parseInt(m[1]!, 10);
  if (!Number.isFinite(start)) return null;
  if (m[2] === undefined) return { start };
  const end = parseInt(m[2], 10);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}
