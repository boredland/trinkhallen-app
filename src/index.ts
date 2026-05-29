import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./env";
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
      scriptSrc: ["'self'", "'unsafe-inline'"],
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
registerPageRoutes(pages);
app.route("/", pages);
app.route("/en", pages);
// The moderation page is fully localized, so expose it per-locale too (keeps the
// header language switcher from dead-ending on /en). Its form POSTs stay at the
// root /api/moderate endpoints.
app.route("/en", moderate);

app.notFound((c) => c.text("404 — Hier gibt's nix.", 404));
app.onError((err, c) => {
  console.error(err);
  return c.text("500 — Da ist was schiefgegangen.", 500);
});

export default app;
