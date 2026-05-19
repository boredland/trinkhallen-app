import type { Hono } from "hono";
import type { Env } from "../env";
import { FilterChips } from "../components/FilterChips";
import { KioskDetail } from "../components/KioskDetail";
import { KioskList } from "../components/KioskList";
import { Layout } from "../components/Layout";
import { countKiosks, getKioskById, queryKiosksAll, queryKiosksInBbox } from "../lib/db";
import { applyFilters, parseFilterFromQuery } from "../lib/filters";
import { parseBbox } from "../lib/geo";
import { getAggregate, getOwnRating } from "../lib/ratings";

export function registerPageRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/", async (c) => {
    const url = new URL(c.req.url);
    const filter = parseFilterFromQuery(url.searchParams);
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
            data-style="/style-night.json"
            data-filter-state={url.search}
          />
          <aside class="pointer-events-auto absolute inset-x-0 bottom-0 z-10 flex max-h-[60dvh] flex-col border-t-2 border-border bg-surface/95 backdrop-blur sm:inset-y-0 sm:bottom-auto sm:left-0 sm:right-auto sm:max-h-none sm:w-[380px] sm:border-r-2 sm:border-t-0">
            <div class="border-b-2 border-border p-3">
              <FilterChips filter={filter} formAction="/" />
            </div>
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
            userAgent={c.req.header("user-agent") ?? null}
          />
        </section>

        {totalPages > 1 && <Paginator page={page} totalPages={totalPages} baseUrl={url} />}
      </Layout>,
    );
  });

  app.get("/about", (c) =>
    c.html(
      <Layout title="Über" nav="about" user={c.get("user")}>
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
    const user = c.get("user");
    const kiosk = await getKioskById(c.env.DB, id);
    if (!kiosk) {
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
    return c.html(
      <Layout title={kiosk.name} nav="map" user={user}>
        <KioskDetail
          kiosk={kiosk}
          userAgent={c.req.header("user-agent") ?? null}
          aggregate={aggregate}
          ownRating={ownRating}
          isLoggedIn={!!user}
        />
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

            <div class="my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-fg-dim">
              <span class="h-px flex-1 bg-border" />
              <span>oder</span>
              <span class="h-px flex-1 bg-border" />
            </div>

            <a href="/auth/google" class="btn-neon inline-flex w-full justify-center sm:w-auto">
              ▶ Mit Google anmelden
            </a>

            <p class="mt-6 text-xs text-fg-dim">
              Wir speichern bei E-Mail-Login nur deine Adresse, bei Google zusätzlich Name und
              Profilbild. Mehr nicht.
            </p>
          </section>
        </Layout>,
      );
    }
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
          <form action="/auth/logout" method="post" class="mt-6">
            <button type="submit" class="border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wide text-fg-muted transition-colors hover:border-neon-pink hover:text-neon-pink">
              Abmelden
            </button>
          </form>
        </section>

        <section class="mt-6 border-2 border-border bg-surface p-6">
          <h2 class="font-display text-xl tracking-wide text-fg">Deine Beiträge</h2>
          <p class="mt-2 text-fg-muted">
            Bewertungen, Korrekturen und eingereichte Kioske erscheinen hier — sobald die
            Funktionen freigeschaltet sind.
          </p>
        </section>
      </Layout>,
    );
  });
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
