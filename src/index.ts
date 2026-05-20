import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./env";
import { apiKiosks } from "./routes/api.kiosks.tsx";
import { apiRatings } from "./routes/api.ratings.tsx";
import { apiReports } from "./routes/api.reports.tsx";
import { apiSubmissions } from "./routes/api.submissions.tsx";
import { apiSync } from "./routes/api.sync";
import { moderate } from "./routes/moderate.tsx";
import { auth, attachUser } from "./routes/auth.tsx";
import { registerPageRoutes } from "./routes/pages";

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      // Anton + Inter from Google Fonts
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://lh3.googleusercontent.com"],
      // MapLibre uses workers + wasm; Alpine + HTMX are bundled local
      scriptSrc: ["'self'", "'unsafe-inline'"],
      workerSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "https://tiles.trinkhallen.app", "https://api.protomaps.com"],
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
app.route("/", apiSync);
app.route("/", moderate);
registerPageRoutes(app);

app.notFound((c) => c.text("404 — Hier gibt's nix.", 404));
app.onError((err, c) => {
  console.error(err);
  return c.text("500 — Da ist was schiefgegangen.", 500);
});

export default app;
