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

  app.get("/add", (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/me?after=add");
    const url = new URL(c.req.url);
    const initialLat = url.searchParams.get("lat") ?? "";
    const initialLng = url.searchParams.get("lng") ?? "";
    const error = url.searchParams.get("error");
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

  const [reportsRes, submissionsRes] = await Promise.all([
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
  ]);

  const reports = reportsRes.results;
  const submissions = submissionsRes.results;
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
