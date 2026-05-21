import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./env";
import { apiKiosks } from "./routes/api.kiosks.tsx";
import { apiRatings } from "./routes/api.ratings.tsx";
import { apiReports } from "./routes/api.reports.tsx";
import { apiSubmissions } from "./routes/api.submissions.tsx";
import { attachUser, auth } from "./routes/auth.tsx";
import { moderate } from "./routes/moderate.tsx";
import { registerPageRoutes } from "./routes/pages";

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
      connectSrc: ["'self'", "https://tiles.openfreemap.org"],
      frameAncestors: ["'none'"],
    },
  }),
);

app.use("*", attachUser);
app.route("/", auth);
app.route("/", apiKiosks);
app.route("/", apiRatings);
app.route("/", apiReports);
app.route("/", apiSubmissions);
app.route("/", moderate);
registerPageRoutes(app);

app.notFound((c) => c.text("404 — Hier gibt's nix.", 404));
app.onError((err, c) => {
  console.error(err);
  return c.text("500 — Da ist was schiefgegangen.", 500);
});

export default app;
