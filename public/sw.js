/* trinkhallen.app — service worker
 *
 * Four caches, each with its own strategy:
 *
 *   tk-static-vN
 *     Hashed JS/CSS bundles from /assets, plus the small static art in
 *     /public. Cache-first, immutable. Versioning is via the filename
 *     hash; the SW just stores whatever it's asked for.
 *
 *   tk-tiles-vN
 *     OpenFreeMap's style JSON, glyphs, sprite, and vector tiles
 *     (everything at https://tiles.openfreemap.org). Cache-first.
 *
 *   tk-data-vN
 *     Per-region kiosk GeoJSON + manifest + summary served from /data/*.
 *     URLs are stable across deploys (we rewrite the file content), so
 *     stale-while-revalidate gives users an instant map on repeat visits
 *     and a quiet background refresh that picks up the next deploy's data
 *     within a single page-load.
 *
 *   tk-runtime-vN
 *     SSR pages and the legacy /api/kiosks fallback. Stale-while-
 *     revalidate so the user gets last-known content instantly on repeat
 *     visits while we fetch the fresh version in the background.
 *
 * Bump VERSION below to invalidate everything.
 */

const VERSION = "v5";
const STATIC_CACHE = `tk-static-${VERSION}`;
const TILES_CACHE = `tk-tiles-${VERSION}`;
const DATA_CACHE = `tk-data-${VERSION}`;
const RUNTIME_CACHE = `tk-runtime-${VERSION}`;
const ALL_CACHES = [STATIC_CACHE, TILES_CACHE, DATA_CACHE, RUNTIME_CACHE];

const TILES_HOSTS = new Set(["tiles.openfreemap.org"]);
const STATIC_PATH_PREFIXES = ["/assets/", "/favicon.svg", "/apple-touch-icon.svg"];
// Per-user / auth-sensitive paths — never cache these. The HTML differs
// per session (logged-in chrome, profile data, moderation queue) and a
// stale-while-revalidate snapshot would flash the wrong state on the
// first paint after any auth transition.
const PRIVATE_PATH_PREFIXES = ["/me", "/moderate", "/add", "/auth"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // Pre-warm the app shell so the first offline visit lands on something.
  // `/me` is intentionally NOT pre-warmed — it's a per-user page.
  event.waitUntil(
    caches.open(RUNTIME_CACHE).then((cache) =>
      cache.addAll(["/", "/about"]).catch(() => {
        // best-effort; offline-during-install is fine
      }),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("tk-") && !ALL_CACHES.includes(k))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Tiles + Protomaps assets: cache-first, long-term.
  if (TILES_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(req, TILES_CACHE));
    return;
  }

  // Same-origin static art + hashed bundles: cache-first.
  if (
    url.origin === self.location.origin &&
    STATIC_PATH_PREFIXES.some((p) => url.pathname.startsWith(p))
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Google Fonts CSS + glyphs.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // /data/*: per-region kiosk GeoJSON + manifest. Stale-while-revalidate so
  // the next map pan is instant offline AND picks up the deploy's new data
  // on the very next request.
  if (url.origin === self.location.origin && url.pathname.startsWith("/data/")) {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }

  // Legacy /api/kiosks fallback: stale-while-revalidate keyed by the exact
  // request URL (which already includes bbox + filter signature). The map's
  // hot path now reads /data/* directly; this only covers any consumers
  // still using the API.
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/kiosks")) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // Navigation requests: stale-while-revalidate so repeat visits paint
  // the cached SSR HTML instantly, then refresh in the background. The
  // SSR is cheap (single-digit ms) so users on a fresh deploy see new
  // HTML within one navigation.
  // EXCEPT per-user / auth-sensitive paths: those bypass the SW entirely
  // so the user sees their actual current state, not a leftover snapshot
  // from a prior session.
  if (req.mode === "navigate") {
    if (
      url.origin === self.location.origin &&
      PRIVATE_PATH_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))
    ) {
      return; // pass through to the network
    }
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // Everything else: pass through.
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const resp = await fetch(req);
  // Cache full + opaque responses, ignore HTTP errors.
  if (resp.ok || resp.type === "opaque") {
    cache.put(req, resp.clone()).catch(() => {});
  }
  return resp;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreVary: true });
  const fresh = fetch(req)
    .then((resp) => {
      if (resp.ok) cache.put(req, resp.clone()).catch(() => {});
      return resp;
    })
    .catch(() => null);
  return cached ?? (await fresh) ?? Response.error();
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(req);
    if (resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch {
    const cached = await cache.match(req, { ignoreVary: true });
    if (cached) return cached;
    throw new Error("offline + nothing cached");
  }
}
