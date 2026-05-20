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
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      // Anton + Inter from Google Fonts; PBF glyphs from Protomaps' assets host
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://protomaps.github.io"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      // Avatars + Protomaps basemap sprite (PNG + JSON metadata)
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://lh3.googleusercontent.com",
        "https://protomaps.github.io",
      ],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      workerSrc: ["'self'", "blob:"],
      // tiles.trinkhallen.app: PMTiles range fetches.
      // protomaps.github.io: sprite + glyph fetches by MapLibre.
      connectSrc: [
        "'self'",
        "https://tiles.trinkhallen.app",
        "https://protomaps.github.io",
        "https://api.protomaps.com",
      ],
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
