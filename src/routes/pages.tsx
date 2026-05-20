import type { Hono } from "hono";
import type { Env } from "../env";
import { FilterChips } from "../components/FilterChips";
import { KioskDetail } from "../components/KioskDetail";
import { KioskList } from "../components/KioskList";
import { Layout } from "../components/Layout";
import { countKiosks, getKioskById, queryKiosksAll, queryKiosksInBbox } from "../lib/db";
import { applyFilters, isFilterActive, parseFilterFromQuery } from "../lib/filters";
import { parseBbox } from "../lib/geo";
import { getAggregate, getOwnRating } from "../lib/ratings";
import { PMTILES_URL, pmtilesAvailable } from "../lib/tiles-available";

export function registerPageRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/", async (c) => {
    const url = new URL(c.req.url);
    const filter = parseFilterFromQuery(url.searchParams);
    const tilesMode = (await pmtilesAvailable(c.env, c.executionCtx)) ? "pmtiles" : "raster";
    // Initial render: hard-code Frankfurt-ish bbox so the side panel isn't empty
    // on first paint. The map's moveend handler will swap this with the actual
    // viewport via HTMX once it loads.
    const initialBbox = parseBbox(url.searchParams.get("bbox") ?? "8.4,50.0,8.9,50.3");
    let initialPanel = (
      <KioskList kiosks={[]} totalInBbox={0} filteredCount={0} userAgent={null} />
    );
    if (initialBbox) {
      const all = await queryKiosksInBbox(c.env.DB, initialBbox, 5000);
      const filtered = applyFilters(all, filter);
      filtered.sort((a, b) => a.name.localeCompare(b.name, "de"));
      initialPanel = (
        <KioskList
          kiosks={filtered.slice(0, 100)}
          totalInBbox={all.length}
          filteredCount={filtered.length}
          filterActive={isFilterActive(filter)}
          resetHref="/"
          userAgent={c.req.header("user-agent") ?? null}
        />
      );
    }

    return c.html(
      <Layout title="Karte" nav="map" clientEntries={["app", "map"]} fullBleed user={c.get("user")}>
        <div class="relative h-full w-full">
          <div
            id="map"
            class="h-full w-full bg-surface"
            data-bbox="5.87,47.27,15.04,55.06"
            data-tiles={tilesMode}
            data-pmtiles-url={tilesMode === "pmtiles" ? PMTILES_URL : undefined}
            data-filter-state={url.search}
          />
          {/* Backdrop has to live OUTSIDE the sheet element: the sheet uses
              `transform` for slide animation, and a transformed ancestor
              becomes the containing block for `position: fixed` descendants.
              If the backdrop is nested, `inset-0` resolves to the sheet's
              own bounding box and clicks above the sheet never reach it. */}
          <div
            id="kiosk-sheet-backdrop"
            class="pointer-events-none fixed inset-0 z-20 bg-bg/60 opacity-0 transition-opacity duration-200 data-[open=true]:pointer-events-auto data-[open=true]:opacity-100"
            data-open="false"
          />
          {/* Sheet container — populated by client/sheet.ts when a marker
              or list item is clicked. Slides over both map and sidebar. */}
          <div
            id="kiosk-sheet"
            class="pointer-events-none fixed inset-x-0 bottom-0 z-30 translate-y-full transition-transform duration-200 ease-out data-[open=true]:pointer-events-auto data-[open=true]:translate-y-0 sm:inset-y-0 sm:bottom-auto sm:right-0 sm:max-h-none sm:w-full sm:max-w-md sm:translate-x-full sm:translate-y-0 sm:data-[open=true]:translate-x-0"
            data-open="false"
            aria-hidden="true"
          >
            <div class="relative flex h-full max-h-[90dvh] flex-col bg-surface border-t-2 border-border sm:max-h-none sm:border-l-2 sm:border-t-0">
              <button
                type="button"
                aria-label="Sheet schließen — nach unten ziehen"
                data-sheet-handle
                class="flex w-full cursor-grab touch-none items-center justify-center py-2 sm:hidden"
              >
                <span class="block h-1 w-10 rounded-full bg-border-hi" />
              </button>
              <button
                type="button"
                aria-label="Schließen"
                data-sheet-close
                class="absolute right-4 top-4 z-10 hidden h-8 w-8 cursor-pointer items-center justify-center border-2 border-border-hi font-display text-fg-muted hover:border-neon-pink hover:text-neon-pink sm:flex"
              >
                ×
              </button>
              <div id="kiosk-sheet-body" class="flex-1 overflow-y-auto overscroll-contain" />
            </div>
          </div>

          <aside class="pointer-events-auto absolute inset-x-0 bottom-0 z-10 flex max-h-[60dvh] flex-col border-t-2 border-border bg-surface/95 backdrop-blur sm:inset-y-0 sm:bottom-auto sm:left-0 sm:right-auto sm:max-h-none sm:w-[380px] sm:border-r-2 sm:border-t-0">
            <div class="border-b-2 border-border p-3">
              <FilterChips filter={filter} formAction="/" />
            </div>
            <a
              href="/add"
              class="flex items-center justify-center gap-2 border-b-2 border-border bg-surface-2 px-3 py-2 font-display text-sm tracking-wider uppercase text-fg-muted transition-colors hover:text-neon-pink"
            >
              <span class="text-neon-pink">+</span> Späti vorschlagen
            </a>
            <div
              id="kiosk-panel"
              class="min-h-0 flex-1 overflow-hidden"
              data-panel-url={`/api/kiosks/panel${initialBbox ? `?bbox=${initialBbox.west},${initialBbox.south},${initialBbox.east},${initialBbox.north}` : ""}`}
            >
              {initialPanel}
            </div>
          </aside>
        </div>
      </Layout>,
    );
  });

  app.get("/list", async (c) => {
    const url = new URL(c.req.url);
    const filter = parseFilterFromQuery(url.searchParams);
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const PER_PAGE = 50;

    const [all, total] = await Promise.all([
      queryKiosksAll(c.env.DB, 5000),
      countKiosks(c.env.DB),
    ]);
    const filtered = applyFilters(all, filter);
    const start = (page - 1) * PER_PAGE;
    const slice = filtered.slice(start, start + PER_PAGE);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));

    return c.html(
      <Layout title="Liste" nav="list" user={c.get("user")}>
        <header class="mb-6">
          <h1 class="font-display text-4xl tracking-wide text-fg">Liste</h1>
          <p class="mt-1 text-sm text-fg-muted">
            {filtered.length === total
              ? `${total.toLocaleString("de-DE")} Trinkhallen insgesamt`
              : `${filtered.length.toLocaleString("de-DE")} von ${total.toLocaleString("de-DE")} (gefiltert)`}
          </p>
          <div class="mt-4 border-2 border-border bg-surface p-3">
            <FilterChips filter={filter} formAction="/list" />
          </div>
        </header>

        <section class="border-2 border-border bg-surface">
          <KioskList
            kiosks={slice}
            totalInBbox={total}
            filteredCount={filtered.length}
            variant="page"
            filterActive={isFilterActive(filter)}
            resetHref="/list"
            userAgent={c.req.header("user-agent") ?? null}
          />
        </section>

        {totalPages > 1 && <Paginator page={page} totalPages={totalPages} baseUrl={url} />}
      </Layout>,
    );
  });

  app.get("/about", async (c) => {
    const total = await countKiosks(c.env.DB);
    return c.html(
      <Layout title="Über" nav="about" user={c.get("user")}>
        <article class="space-y-10">
          <header>
            <h1 class="font-display text-4xl tracking-wide text-fg sm:text-6xl">
              trinkhallen<span class="text-neon-pink">.</span>app
            </h1>
            <p class="mt-3 text-lg text-fg-muted">
              {total.toLocaleString("de-DE")} Trinkhallen, Wasserhäuschen und Spätis in einer Karte. Offen,
              durchsuchbar, von der Community gepflegt — nicht-kommerziell.
            </p>
          </header>

          <section>
            <h2 class="font-display text-2xl tracking-wide text-fg">▶▶▶ Was ist das?</h2>
            <p class="mt-3 text-fg-muted">
              Du suchst einen Späti mit Kartenzahlung, der gerade offen hat, und willst direkt hin
              navigieren? Genau dafür ist trinkhallen.app gebaut. Das Projekt ist von{" "}
              <a class="text-neon-cyan underline-offset-2 hover:underline" href="https://app.hopfenstop.de/">
                HopfenStop
              </a>{" "}
              inspiriert und erweitert dessen Frankfurter Datensatz um eine offene Beitrags-Pipeline und Daten
              für ganz Deutschland aus OpenStreetMap.
            </p>
          </section>

          <section>
            <h2 class="font-display text-2xl tracking-wide text-fg">▶▶▶ Daten</h2>
            <p class="mt-3 text-fg-muted">
              Alle Kiosk-Metadaten liegen offen auf GitHub als GeoJSON, mit pro-Eintrag Quellenangabe
              (<code class="font-mono">sources[]</code>):
            </p>
            <ul class="mt-3 space-y-2 text-fg-muted">
              <li>
                <a class="text-neon-cyan underline-offset-2 hover:underline" href="https://github.com/boredland/trinkhallen-data">
                  boredland/trinkhallen-data
                </a>{" "}
                — der Datensatz. PRs willkommen.
              </li>
              <li>
                <a class="text-neon-cyan underline-offset-2 hover:underline" href="https://github.com/boredland/trinkhallen-app">
                  boredland/trinkhallen-app
                </a>{" "}
                — Code (Cloudflare Workers + Hono).
              </li>
            </ul>
            <p class="mt-3 text-sm text-fg-dim">
              <strong>Quellen:</strong> HopfenStop (Frankfurt-Seed,{" "}
              <a class="text-neon-cyan underline-offset-2 hover:underline" href="https://creativecommons.org/licenses/by-nc/4.0/">
                CC BY-NC 4.0
              </a>
              ) · OpenStreetMap (
              <a class="text-neon-cyan underline-offset-2 hover:underline" href="https://www.openstreetmap.org/copyright">
                ODbL
              </a>
              ) · Beiträge der Nutzer:innen.
            </p>
          </section>

          <section>
            <h2 class="font-display text-2xl tracking-wide text-fg">▶▶▶ Mitmachen</h2>
            <ul class="mt-3 space-y-3 text-fg-muted">
              <li>
                <span class="font-display text-fg">Bewerten:</span> 1–5 Sterne + optionaler Kommentar auf jeder
                Detailseite (Login nötig).
              </li>
              <li>
                <span class="font-display text-fg">Korrigieren:</span> „Daten falsch?"-Knopf auf der Detailseite
                → öffnet ein GitHub-Issue zur Moderation.
              </li>
              <li>
                <span class="font-display text-fg">Vorschlagen:</span>{" "}
                <a class="text-neon-cyan underline-offset-2 hover:underline" href="/add">
                  /add
                </a>{" "}
                → Späti auf der Karte anklicken, Adresse + Öffnungszeiten + Zahlung eintragen.
              </li>
              <li>
                <span class="font-display text-fg">Direkt PR auf GitHub:</span> Wer mag, kann den Datensatz auch
                direkt forken und PRs gegen{" "}
                <a class="text-neon-cyan underline-offset-2 hover:underline" href="https://github.com/boredland/trinkhallen-data">
                  trinkhallen-data
                </a>{" "}
                öffnen — der Datensatz ist primary, die App nur die UI obendrauf.
              </li>
            </ul>
          </section>

          <section>
            <h2 class="font-display text-2xl tracking-wide text-fg">▶▶▶ Stack</h2>
            <ul class="mt-3 space-y-1.5 text-sm text-fg-muted">
              <li>Cloudflare Workers · Hono · TypeScript · D1 (SQLite)</li>
              <li>MapLibre GL JS · OSM-Raster (PMTiles folgt)</li>
              <li>Tailwind CSS v4 · Anton / Inter · keine Tracker</li>
              <li>Auth: Magic-Link via Cloudflare Email Sending, Google SSO</li>
              <li>Weekly OSM-Ingest via GitHub Actions + Overpass API</li>
            </ul>
          </section>

          <section>
            <h2 class="font-display text-2xl tracking-wide text-fg">▶▶▶ Lizenz</h2>
            <p class="mt-3 text-sm text-fg-muted">
              <strong class="text-fg">Daten:</strong> CC BY-NC 4.0 — frei zum Teilen und Anpassen, mit
              Attribution, nicht-kommerziell.
              <br />
              <strong class="text-fg">Code:</strong> AGPL-3.0-or-later.
            </p>
          </section>

          <footer class="pt-4 text-xs text-fg-dim">
            Bugs &amp; Wünsche → <a class="text-neon-cyan underline-offset-2 hover:underline" href="https://github.com/boredland/trinkhallen-app/issues">GitHub Issues</a>.
          </footer>
        </article>
      </Layout>,
    );
  });

  app.get("/k/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    const partial = c.req.query("partial") === "1";
    const kiosk = await getKioskById(c.env.DB, id);
    if (!kiosk) {
      if (partial) return c.text("not found", 404);
      return c.html(
        <Layout title="Nicht gefunden" nav="map" user={user}>
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
    const [aggregate, ownRating] = await Promise.all([
      getAggregate(c.env, kiosk.id),
      user ? getOwnRating(c.env, kiosk.id, user.id) : Promise.resolve(null),
    ]);
    const detail = (
      <KioskDetail
        kiosk={kiosk}
        userAgent={c.req.header("user-agent") ?? null}
        aggregate={aggregate}
        ownRating={ownRating}
        isLoggedIn={!!user}
      />
    );
    // ?partial=1 → bare HTML for sheet injection on the map page.
    if (partial) return c.html(detail);
    return c.html(
      <Layout title={kiosk.name} nav="map" user={user}>
        {detail}
      </Layout>,
    );
  });

  app.get("/add", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/me?after=add");
    const url = new URL(c.req.url);
    const initialLat = url.searchParams.get("lat") ?? "";
    const initialLng = url.searchParams.get("lng") ?? "";
    const error = url.searchParams.get("error");
    const pickTilesMode = (await pmtilesAvailable(c.env, c.executionCtx)) ? "pmtiles" : "raster";
    return c.html(
      <Layout title="Späti hinzufügen" nav="map" user={user} clientEntries={["app", "pick"]}>
        <header class="mb-6">
          <h1 class="font-display text-4xl tracking-wide text-fg">Späti vorschlagen</h1>
          <p class="mt-2 text-fg-muted">
            Dein Vorschlag landet als Pull Request auf{" "}
            <a class="text-neon-cyan underline-offset-2 hover:underline" href="https://github.com/boredland/trinkhallen-data">
              GitHub
            </a>{" "}
            und wird von Moderator:innen geprüft.
          </p>
        </header>

        {error && (
          <div class="mb-4 border-2 border-danger/60 bg-danger/10 p-3 text-danger">
            {error === "basics" && "Name und Koordinaten sind Pflicht."}
            {error === "coords" && "Koordinaten sind ungültig."}
          </div>
        )}

        <form action="/add" method="post" class="space-y-6 border-2 border-border bg-surface p-6">
          <fieldset class="space-y-3">
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">Ort</legend>
            <div
              id="pick-map"
              class="h-72 w-full border-2 border-border-hi bg-bg sm:h-96"
              data-tiles={pickTilesMode}
              data-pmtiles-url={pickTilesMode === "pmtiles" ? PMTILES_URL : undefined}
            />
            <p class="text-xs text-fg-dim">
              ▶ Klick auf die Karte, um die genaue Position zu setzen. Geolokalisierung
              (Pfeil-Symbol oben rechts) füllt automatisch ein.
            </p>
            <div class="grid grid-cols-2 gap-3">
              <label>
                <span class="block text-xs uppercase tracking-wider text-fg-dim">Breitengrad (lat)</span>
                <input
                  type="number"
                  step="any"
                  name="lat"
                  required
                  value={initialLat}
                  placeholder="50.1109"
                  class="mt-1 w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 font-mono text-fg focus:border-neon-pink focus:outline-none"
                />
              </label>
              <label>
                <span class="block text-xs uppercase tracking-wider text-fg-dim">Längengrad (lng)</span>
                <input
                  type="number"
                  step="any"
                  name="lng"
                  required
                  value={initialLng}
                  placeholder="8.6821"
                  class="mt-1 w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 font-mono text-fg focus:border-neon-pink focus:outline-none"
                />
              </label>
            </div>
          </fieldset>

          <fieldset class="space-y-3">
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">Name &amp; Adresse</legend>
            <label>
              <span class="block text-xs uppercase tracking-wider text-fg-dim">Name *</span>
              <input
                type="text"
                name="name"
                required
                maxLength={200}
                placeholder="z. B. Kayo am Rebstock"
                class="mt-1 w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
              />
            </label>
            <input type="text" name="street" placeholder="Straße" class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none" />
            <div class="grid grid-cols-3 gap-3">
              <input type="text" name="number" placeholder="Nr" class="border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none" />
              <input type="text" name="postalcode" placeholder="PLZ" maxLength={5} class="border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none" />
              <input type="text" name="city" placeholder="Stadt" class="border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none" />
            </div>
            <input type="text" name="district" placeholder="Stadtteil" class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none" />
          </fieldset>

          <fieldset class="space-y-2">
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">Beschreibung</legend>
            <textarea
              name="description"
              rows={3}
              maxLength={2000}
              placeholder="Was macht den Späti besonders?"
              class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
            />
          </fieldset>

          <fieldset class="space-y-2">
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">Öffnungszeiten</legend>
            <input
              type="text"
              name="hours_raw"
              placeholder="Mo-Fr 09:00-22:00; Sa 10:00-20:00"
              class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 font-mono text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
            />
            <p class="text-xs text-fg-dim">
              OSM <code>opening_hours</code>-Format.
            </p>
          </fieldset>

          <fieldset class="space-y-2">
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">Zahlung</legend>
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(["cash", "cards", "contactless", "girocard", "mobile"] as const).map((key) => (
                <label class="flex items-center gap-2 border-2 border-border bg-surface-2 px-2 py-1.5 text-sm">
                  <span class="flex-1 capitalize text-fg-muted">{key}</span>
                  <select
                    name={`pay_${key}`}
                    class="bg-transparent text-fg focus:outline-none"
                  >
                    <option value="">?</option>
                    <option value="yes">Ja</option>
                    <option value="no">Nein</option>
                    <option value="unknown">Unbekannt</option>
                  </select>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset class="space-y-2">
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">Tags</legend>
            <div class="flex flex-wrap gap-2">
              {[
                ["snacks", "Snacks"],
                ["bier", "Bier"],
                ["kaffee", "Kaffee"],
                ["eis", "Eis"],
                ["zeitungen", "Zeitungen"],
                ["lotto", "Lotto"],
                ["wc", "WC"],
                ["sitzgelegenheiten", "Sitzgelegenheiten"],
                ["innenraum", "Innenraum"],
                ["draussen", "Draußen"],
                ["barrierefrei", "Barrierefrei"],
                ["automat", "Automat"],
              ].map(([slug, label]) => (
                <label class="cursor-pointer border-2 border-border bg-surface-2 px-2 py-1 text-sm text-fg-muted has-[:checked]:border-neon-pink has-[:checked]:text-neon-pink">
                  <input type="checkbox" name="tags" value={slug} class="sr-only" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <button type="submit" class="btn-neon">
            ▶ Vorschlag einreichen
          </button>
        </form>
      </Layout>,
    );
  });

  app.get("/me", (c) => {
    const user = c.get("user");
    if (!user) {
      const magic = c.req.query("magic");
      return c.html(
        <Layout title="Anmelden" nav="me" user={undefined}>
          <section class="border-2 border-border bg-surface p-8">
            <h1 class="font-display text-3xl tracking-wide text-fg sm:text-4xl">Anmelden</h1>
            <p class="mt-3 text-fg-muted">
              Anmelden, um Spätis zu bewerten und Korrekturen einzureichen. Anonyme
              Nutzung der Karte bleibt jederzeit möglich.
            </p>

            {magic === "sent" && (
              <div class="mt-6 border-2 border-success/60 bg-success/10 p-4 text-success">
                ▶▶▶ Check deinen Posteingang. Der Link ist 15 Minuten gültig.
              </div>
            )}
            {magic === "invalid" && (
              <div class="mt-6 border-2 border-danger/60 bg-danger/10 p-4 text-danger">
                Diese E-Mail-Adresse sieht nicht gültig aus.
              </div>
            )}
            {magic === "expired" && (
              <div class="mt-6 border-2 border-danger/60 bg-danger/10 p-4 text-danger">
                Der Login-Link ist abgelaufen oder schon verwendet. Forder einen neuen an.
              </div>
            )}

            <form action="/auth/magic" method="post" class="mt-6 flex flex-col gap-3 sm:flex-row sm:items-stretch">
              <label class="flex-1">
                <span class="sr-only">E-Mail-Adresse</span>
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="du@beispiel.de"
                  class="w-full border-2 border-border-hi bg-surface-2 px-3 py-2.5 text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
                />
              </label>
              <button type="submit" class="btn-neon shrink-0">
                ▶ Login-Link per Mail
              </button>
            </form>

            <p class="mt-6 text-xs text-fg-dim">
              Wir speichern nur deine E-Mail-Adresse. Mehr nicht.
            </p>
          </section>
        </Layout>,
      );
    }
    return renderProfile(c, user);
  });
}

interface ReportListRow {
  id: string;
  kiosk_id: string;
  kiosk_name: string;
  kind: string;
  status: string;
  pr_url: string | null;
  created_at: number;
}
interface SubmissionListRow {
  id: string;
  payload: string;
  status: string;
  pr_url: string | null;
  created_at: number;
}

interface ProfileUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: "user" | "moderator" | "admin";
}

async function renderProfile(
  c: import("hono").Context<{ Bindings: Env }>,
  user: ProfileUser,
): Promise<Response> {
  const reportedFlag = c.req.query("reported");
  const submittedFlag = c.req.query("submitted");

  const [reportsRes, submissionsRes, ratingsCountRow] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT r.id, r.kiosk_id, k.name AS kiosk_name, r.kind, r.status, r.pr_url, r.created_at
         FROM reports r JOIN kiosks k ON k.id = r.kiosk_id
         WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 50`,
      )
      .bind(user.id)
      .all<ReportListRow>(),
    c.env.DB
      .prepare(
        `SELECT id, payload, status, pr_url, created_at FROM submissions
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      )
      .bind(user.id)
      .all<SubmissionListRow>(),
    c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM ratings WHERE user_id = ?`)
      .bind(user.id)
      .first<{ n: number }>(),
  ]);

  const reports = reportsRes.results;
  const submissions = submissionsRes.results;
  const ratingsCount = ratingsCountRow?.n ?? 0;
  const fmtDate = (s: number) => new Date(s * 1000).toLocaleDateString("de-DE");

  return c.html(
    <Layout title="Profil" nav="me" user={user}>
      <section class="border-2 border-border bg-surface p-6">
        <div class="flex items-center gap-4">
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              width="64"
              height="64"
              class="rounded-full border-2 border-border-hi"
              referrerpolicy="no-referrer"
            />
          ) : (
            <span class="grid h-16 w-16 place-items-center border-2 border-border-hi bg-neon-pink/20 font-display text-2xl text-neon-pink">
              {(user.displayName ?? user.email)[0]!.toUpperCase()}
            </span>
          )}
          <div>
            <h1 class="font-display text-3xl tracking-wide text-fg">
              {user.displayName ?? user.email}
            </h1>
            <p class="text-fg-muted">{user.email}</p>
            <p class="mt-1 text-xs uppercase tracking-wider text-fg-dim">
              Rolle: {user.role}
            </p>
          </div>
        </div>
        <dl class="mt-6 grid grid-cols-3 gap-3 text-center">
          <Stat n={ratingsCount} label="Bewertungen" />
          <Stat n={reports.length} label="Korrekturen" />
          <Stat n={submissions.length} label="Vorschläge" />
        </dl>
        <form action="/auth/logout" method="post" class="mt-6">
          <button type="submit" class="border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wide text-fg-muted transition-colors hover:border-neon-pink hover:text-neon-pink">
            Abmelden
          </button>
        </form>
      </section>

      {submittedFlag === "ok" && (
        <div class="mt-6 border-2 border-success/60 bg-success/10 p-4 text-success">
          ▶▶▶ Vorschlag gespeichert. Moderator:innen schauen drüber.
        </div>
      )}
      {reportedFlag === "ok" && (
        <div class="mt-6 border-2 border-success/60 bg-success/10 p-4 text-success">
          ▶▶▶ Hinweis gespeichert. Danke!
        </div>
      )}

      <section class="mt-6 border-2 border-border bg-surface">
        <header class="flex items-center justify-between border-b-2 border-border px-4 py-3">
          <h2 class="font-display text-xl tracking-wide text-fg">Vorschläge</h2>
          <a href="/add" class="border-2 border-border-hi px-2 py-1 font-display text-xs tracking-wider uppercase text-fg-muted hover:border-neon-pink hover:text-neon-pink">
            + Späti vorschlagen
          </a>
        </header>
        {submissions.length === 0 ? (
          <p class="p-4 text-fg-muted">
            Noch nichts vorgeschlagen — leg{" "}
            <a class="text-neon-cyan underline-offset-2 hover:underline" href="/add">
              hier
            </a>{" "}
            los.
          </p>
        ) : (
          <ul class="divide-y-2 divide-border">
            {submissions.map((s) => {
              const payload = JSON.parse(s.payload) as { properties: { name?: string } };
              return (
                <li class="px-4 py-3 text-sm">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="font-display text-base tracking-wide text-fg">
                      {payload.properties?.name ?? "(ohne Name)"}
                    </span>
                    <span class="text-xs text-fg-dim">{fmtDate(s.created_at)}</span>
                  </div>
                  <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <StatusPill status={s.status} />
                    {s.pr_url && (
                      <a class="text-neon-cyan underline-offset-2 hover:underline" href={s.pr_url}>
                        PR ansehen →
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section class="mt-6 border-2 border-border bg-surface">
        <header class="border-b-2 border-border px-4 py-3">
          <h2 class="font-display text-xl tracking-wide text-fg">Korrekturen</h2>
        </header>
        {reports.length === 0 ? (
          <p class="p-4 text-fg-muted">Du hast noch keine Fehler gemeldet.</p>
        ) : (
          <ul class="divide-y-2 divide-border">
            {reports.map((r) => (
              <li class="px-4 py-3 text-sm">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <a
                    href={`/k/${r.kiosk_id}`}
                    class="font-display text-base tracking-wide text-fg hover:text-neon-pink"
                  >
                    {r.kiosk_name}
                  </a>
                  <span class="text-xs text-fg-dim">{fmtDate(r.created_at)}</span>
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                  <span class="border-2 border-border px-2 py-0.5">{kindLabel(r.kind)}</span>
                  <StatusPill status={r.status} />
                  {r.pr_url && (
                    <a class="text-neon-cyan underline-offset-2 hover:underline" href={r.pr_url}>
                      PR →
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Layout>,
  );
}

const KIND_LABEL_DE: Record<string, string> = {
  wrong_hours: "Öffnungszeiten",
  wrong_address: "Adresse",
  closed: "Geschlossen",
  duplicate: "Duplikat",
  other: "Sonstiges",
};
function kindLabel(k: string): string {
  return KIND_LABEL_DE[k] ?? k;
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div class="border-2 border-border bg-surface-2 py-3">
      <div class="font-display text-3xl text-neon-amber tabular-nums">{n}</div>
      <div class="text-xs uppercase tracking-wider text-fg-dim">{label}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { de: string; cls: string }> = {
    open: { de: "Offen", cls: "border-neon-amber text-neon-amber" },
    pending: { de: "Wartet", cls: "border-neon-amber text-neon-amber" },
    pr_opened: { de: "PR offen", cls: "border-neon-cyan text-neon-cyan" },
    merged: { de: "Übernommen", cls: "border-success text-success" },
    dismissed: { de: "Verworfen", cls: "border-border text-fg-dim" },
  };
  const cfg = map[status] ?? { de: status, cls: "border-border text-fg-dim" };
  return <span class={`border-2 px-2 py-0.5 ${cfg.cls}`}>{cfg.de}</span>;
}

function Paginator({ page, totalPages, baseUrl }: { page: number; totalPages: number; baseUrl: URL }) {
  const linkFor = (p: number): string => {
    const u = new URL(baseUrl);
    if (p === 1) u.searchParams.delete("page");
    else u.searchParams.set("page", String(p));
    return `${u.pathname}${u.search}`;
  };
  return (
    <nav class="mt-6 flex items-center justify-between gap-3 text-sm">
      {page > 1 ? (
        <a class="border-2 border-border-hi px-3 py-1.5 font-display tracking-wide text-fg hover:border-neon-pink hover:text-neon-pink" href={linkFor(page - 1)}>
          ← Zurück
        </a>
      ) : (
        <span class="border-2 border-border px-3 py-1.5 font-display tracking-wide text-fg-dim">← Zurück</span>
      )}
      <span class="text-fg-muted">
        Seite {page} / {totalPages}
      </span>
      {page < totalPages ? (
        <a class="border-2 border-border-hi px-3 py-1.5 font-display tracking-wide text-fg hover:border-neon-pink hover:text-neon-pink" href={linkFor(page + 1)}>
          Weiter →
        </a>
      ) : (
        <span class="border-2 border-border px-3 py-1.5 font-display tracking-wide text-fg-dim">Weiter →</span>
      )}
    </nav>
  );
}
