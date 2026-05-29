import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { NONCE, secureHeaders } from "hono/secure-headers";
import type { Env } from "./env";
import { DEFAULT_LANG, langFromPath, pathForLang, resolveLang } from "./lib/messages";
import { apiCheckins } from "./routes/api.checkins.tsx";
import { apiKiosks } from "./routes/api.kiosks.tsx";
import { apiRatings } from "./routes/api.ratings.tsx";
import { apiReports } from "./routes/api.reports.tsx";
import { apiSignals } from "./routes/api.signals.tsx";
import { apiSubmissions } from "./routes/api.submissions.tsx";
import { attachUser, auth } from "./routes/auth.tsx";
import { moderate } from "./routes/moderate.tsx";
import { registerPageRoutes } from "./routes/pages";
import { wellKnown } from "./routes/well-known.tsx";

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use(
  "*",
  secureHeaders({
    // HSTS — 1 year + subdomains, eligible for the browser preload list.
    strictTransportSecurity: "max-age=31536000; includeSubDomains; preload",
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      // Fonts are self-hosted (@fontsource bundled into our CSS chunk).
      // OpenFreeMap serves its glyphs from tiles.openfreemap.org.
      fontSrc: ["'self'", "https://tiles.openfreemap.org"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Google avatars + OpenFreeMap raster shading + sprite PNGs.
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://lh3.googleusercontent.com",
        "https://tiles.openfreemap.org",
      ],
      // 'self' covers the bundled module scripts; NONCE generates a per-request
      // nonce (read via c.get("secureHeadersNonce")) for the few inline scripts
      // — JSON-LD, speculation rules, the /jetzt bootstrap — so we can keep
      // 'unsafe-inline' off and retain real XSS containment.
      scriptSrc: ["'self'", NONCE],
      workerSrc: ["'self'", "blob:"],
      // OpenFreeMap: style JSON + vector tiles + sprite metadata.
      // Photon: reverse-geocoding on /add to autofill the address from the
      // user's picked coordinates.
      connectSrc: ["'self'", "https://tiles.openfreemap.org", "https://photon.komoot.io"],
      frameAncestors: ["'none'"],
    },
  }),
);

app.use("*", attachUser);

// CSRF: Origin-header check on state-changing requests, as defence-in-depth
// alongside the SameSite=Lax session cookie. Scoped to the app's own POST
// surfaces (JSON/form APIs + the /me account actions) — deliberately NOT
// /auth/*, because Apple's sign-in callback is a legitimate cross-origin form
// POST and is guarded instead by its own state-cookie match. csrf() is a no-op
// on safe methods, so mounting it on these globs leaves GETs untouched.
app.use("/api/*", csrf());
app.use("/me/*", csrf());
app.use("/en/me/*", csrf());

app.route("/", auth);
app.route("/", apiKiosks);
app.route("/", apiCheckins);
app.route("/", apiSignals);
app.route("/", apiRatings);
app.route("/", apiReports);
app.route("/", apiSubmissions);
app.route("/", moderate);
app.route("/", wellKnown);

// Page routes are locale-addressed: the default language lives at the root and
// every other supported language gets a path prefix (e.g. /en/...). Mounting the
// same sub-app at both keeps a single route definition; handlers read the active
// language from the request path via langFromPath. API/auth/moderation routes
// above stay root-only — the client passes the locale to them explicitly.
const pages = new Hono<{ Bindings: Env }>();

// First-visit language handling. Runs only on page GETs (registered before the
// route handlers). Two jobs:
//   1. `?setlang=xx` — the header switcher's explicit choice: persist a sticky
//      cookie and bounce to the clean URL in that locale.
//   2. Auto-detect — when the visitor's preference (cookie, else Accept-Language)
//      is a non-default language but they're on a default-locale URL, redirect
//      to the prefixed equivalent.
// It only ever *upgrades* a default-locale path to a prefixed one — explicit
// /en URLs and crawlers with no language signal are never bounced, so per-locale
// indexing and shared links stay intact. Normal renders set no cookie, so the
// HTML stays cacheable.
const LANG_COOKIE = "tk_lang";
const LANG_COOKIE_OPTS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "Lax",
  secure: true,
} as const;

pages.use("*", async (c, next) => {
  if (c.req.method !== "GET") return next();
  const url = new URL(c.req.url);

  const setlang = url.searchParams.get("setlang");
  if (setlang !== null) {
    const chosen = resolveLang(setlang);
    setCookie(c, LANG_COOKIE, chosen, LANG_COOKIE_OPTS);
    url.searchParams.delete("setlang");
    return c.redirect(pathForLang(url.pathname, chosen) + url.search, 302);
  }

  // HTMX/sheet partials already target the right locale; don't bounce them.
  if (url.searchParams.has("partial")) return next();

  const cookie = getCookie(c, LANG_COOKIE);
  const preferred = resolveLang(cookie ?? c.req.header("accept-language"));
  if (langFromPath(url.pathname) === DEFAULT_LANG && preferred !== DEFAULT_LANG) {
    if (!cookie) setCookie(c, LANG_COOKIE, preferred, LANG_COOKIE_OPTS);
    return c.redirect(pathForLang(url.pathname, preferred) + url.search, 302);
  }
  return next();
});

registerPageRoutes(pages);
app.route("/", pages);
app.route("/en", pages);
// The moderation page is fully localized, so expose it per-locale too (keeps the
// header language switcher from dead-ending on /en). Its form POSTs stay at the
// root /api/moderate endpoints.
app.route("/en", moderate);

app.notFound((c) => c.text("404 — Hier gibt's nix.", 404));
app.onError((err, c) => {
  // Honour deliberate HTTP errors (e.g. the csrf() middleware's 403) instead of
  // masking every thrown response as a 500. Only genuinely unexpected errors
  // get logged + the generic 500.
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.text("500 — Da ist was schiefgegangen.", 500);
});

export default app;
