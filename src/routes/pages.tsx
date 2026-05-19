import type { Hono } from "hono";
import type { Env } from "../env";
import { KioskDetail } from "../components/KioskDetail";
import { Layout } from "../components/Layout";
import { getKioskById } from "../lib/db";

export function registerPageRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/", (c) => {
    return c.html(
      <Layout title="Karte" nav="map" clientEntries={["app", "map"]} fullBleed>
        <div class="relative h-full w-full">
          <div
            id="map"
            class="h-full w-full bg-surface"
            data-bbox="5.87,47.27,15.04,55.06"
            data-style="/style-night.json"
          />
          <aside class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4 sm:inset-y-0 sm:left-0 sm:right-auto sm:w-[380px] sm:p-6">
            <div class="pointer-events-auto w-full border-2 border-border bg-surface/95 p-4 backdrop-blur">
              <p class="font-display text-2xl tracking-wide text-fg">▶▶▶ HALLO</p>
              <p class="mt-2 text-sm text-fg-muted">
                Der Kartensplitter steckt noch im Setup. Sobald Daten da sind, wirst du hier Spätis in deiner Nähe
                sehen, mit „Hin&nbsp;navigieren" auf einen Klick.
              </p>
            </div>
          </aside>
        </div>
      </Layout>,
    );
  });

  app.get("/list", (c) =>
    c.html(
      <Layout title="Liste" nav="list">
        <h1 class="font-display text-4xl tracking-wide text-fg">Liste</h1>
        <p class="mt-3 text-fg-muted">Folgt im Daten-Slice.</p>
      </Layout>,
    ),
  );

  app.get("/about", (c) =>
    c.html(
      <Layout title="Über" nav="about">
        <h1 class="font-display text-4xl tracking-wide text-fg">Über trinkhallen.app</h1>
        <div class="mt-6 space-y-4 text-fg-muted">
          <p>
            trinkhallen.app ist ein nicht-kommerzielles Projekt, das Trinkhallen, Wasserhäuschen und Spätis in
            Deutschland sichtbar macht. Die Daten liegen offen auf GitHub und werden von der Community gepflegt.
          </p>
          <p>
            <span class="text-fg">Quellen:</span>{" "}
            <a class="text-neon-cyan underline-offset-2 hover:underline" href="https://app.hopfenstop.de/">
              HopfenStop
            </a>{" "}
            (Frankfurt-Seed, CC BY-NC 4.0) · OpenStreetMap (ODbL) · Beiträge der Nutzer:innen.
          </p>
          <p>
            <span class="text-fg">Lizenz:</span> CC BY-NC 4.0 für die Daten, AGPL-3.0 für den Code.
          </p>
        </div>
      </Layout>,
    ),
  );

  app.get("/k/:id", async (c) => {
    const id = c.req.param("id");
    const kiosk = await getKioskById(c.env.DB, id);
    if (!kiosk) {
      return c.html(
        <Layout title="Nicht gefunden" nav="map">
          <h1 class="font-display text-4xl tracking-wide text-fg">404 — Kiosk nicht gefunden</h1>
          <p class="mt-3 text-fg-muted">
            Die ID <code class="font-mono">{id}</code> existiert nicht.{" "}
            <a class="text-neon-cyan underline-offset-2 hover:underline" href="/">
              Zurück zur Karte
            </a>
          </p>
        </Layout>,
        404,
      );
    }
    return c.html(
      <Layout title={kiosk.name} nav="map">
        <KioskDetail kiosk={kiosk} userAgent={c.req.header("user-agent") ?? null} />
      </Layout>,
    );
  });

  app.get("/me", (c) =>
    c.html(
      <Layout title="Profil" nav="me">
        <h1 class="font-display text-4xl tracking-wide text-fg">Profil</h1>
        <p class="mt-3 text-fg-muted">Anmeldung folgt im Auth-Slice.</p>
      </Layout>,
    ),
  );
}
