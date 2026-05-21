import type { Hono } from "hono";
import { FilterChips } from "../components/FilterChips";
import { KioskDetail } from "../components/KioskDetail";
import { KioskList } from "../components/KioskList";
import { Layout } from "../components/Layout";
import type { Env } from "../env";
import {
  countKiosks,
  findNearbyKiosks,
  getKioskById,
  kiosksByRegion,
  loadManifest,
  queryKiosksInBbox,
} from "../lib/asset-kiosks";
import type { KioskRecord } from "../lib/db";
import { applyFilters, isFilterActive, parseFilterFromQuery } from "../lib/filters";
import { parseBbox } from "../lib/geo";
import { computeStatus } from "../lib/opening-hours";
import type { Aggregate } from "../lib/ratings";
import { countRatings, getAggregate, getOwnRating } from "../lib/ratings";

const ORIGIN = "https://trinkhallen.app";

/**
 * Human-readable German names for the per-city landing pages. Slugs not in
 * this map fall back to capitalised-slug.
 */
const CITY_DISPLAY: Record<string, string> = {
  frankfurt: "Frankfurt am Main",
  koeln: "Köln",
  duesseldorf: "Düsseldorf",
  muenchen: "München",
  nuernberg: "Nürnberg",
  muenster: "Münster",
  osnabrueck: "Osnabrück",
  saarbruecken: "Saarbrücken",
  goettingen: "Göttingen",
  luebeck: "Lübeck",
  wuerzburg: "Würzburg",
  halle: "Halle (Saale)",
  ruhr: "Ruhrgebiet",
};

function cityDisplayName(slug: string): string {
  return CITY_DISPLAY[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

function kioskHeadline(kiosk: KioskRecord): string {
  const city = kiosk.address["city"];
  return city ? `${kiosk.name} — Späti in ${city}` : kiosk.name;
}

function kioskDescription(kiosk: KioskRecord): string {
  const city = kiosk.address["city"];
  const district = kiosk.address["district"];
  const where = district && city ? `${district}, ${city}` : (city ?? "Deutschland");
  const hours = kiosk.hours?.raw ? "Öffnungszeiten" : "Öffnungszeiten (Hinweise willkommen)";
  return `${kiosk.name} in ${where} — ${hours}, Zahlungsmethoden und ein Klick zur Navigation auf trinkhallen.app.`;
}

const PAYMENT_TO_SCHEMA: Record<string, string> = {
  cash: "Cash",
  cards: "CreditCard",
  girocard: "DebitCard",
  contactless: "ContactlessPayment",
  mobile: "GooglePay",
};

function kioskBreadcrumbJsonLd(kiosk: KioskRecord): object {
  // `kiosk.region` is the full path like "de/hessen/frankfurt" or
  // "de/nordrhein-westfalen/duesseldorf"; the trailing segment is the
  // slug that matches /stadt/:slug.
  const cityStub = kiosk.region.split("/").pop() ?? null;
  const cityCrumb =
    cityStub != null
      ? {
          "@type": "ListItem",
          position: 2,
          name: cityDisplayName(cityStub),
          item: `${ORIGIN}/stadt/${cityStub}`,
        }
      : null;
  const items: object[] = [
    { "@type": "ListItem", position: 1, name: "Trinkhallen", item: `${ORIGIN}/` },
  ];
  if (cityCrumb) items.push(cityCrumb);
  items.push({
    "@type": "ListItem",
    position: items.length + 1,
    name: kiosk.name,
    item: `${ORIGIN}/k/${kiosk.id}`,
  });
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items,
  };
}

function kioskJsonLd(kiosk: KioskRecord, aggregate?: Aggregate | null): object {
  const addr = kiosk.address;
  const url = `${ORIGIN}/k/${kiosk.id}`;
  const business: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "ConvenienceStore",
    "@id": url,
    url,
    name: kiosk.name,
    address: {
      "@type": "PostalAddress",
      ...(addr["street"] && addr["number"]
        ? { streetAddress: `${addr["street"]} ${addr["number"]}` }
        : addr["street"]
          ? { streetAddress: addr["street"] }
          : {}),
      ...(addr["postalcode"] ? { postalCode: addr["postalcode"] } : {}),
      ...(addr["city"] ? { addressLocality: addr["city"] } : {}),
      ...(addr["district"] ? { addressRegion: addr["district"] } : {}),
      addressCountry: "DE",
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: kiosk.lat,
      longitude: kiosk.lng,
    },
  };
  if (kiosk.hours?.raw) business["openingHours"] = kiosk.hours.raw;
  if (kiosk.payment) {
    const accepted = Object.entries(kiosk.payment)
      .filter(([_, v]) => v === "yes")
      .map(([k]) => PAYMENT_TO_SCHEMA[k])
      .filter(Boolean);
    if (accepted.length) business["paymentAccepted"] = accepted.join(", ");
  }
  if (aggregate && aggregate.count > 0) {
    business["aggregateRating"] = {
      "@type": "AggregateRating",
      ratingValue: aggregate.avg.toFixed(1),
      ratingCount: aggregate.count,
      bestRating: 5,
      worstRating: 1,
    };
  }
  return business;
}

function homepageJsonLd(): object[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${ORIGIN}/#website`,
      url: `${ORIGIN}/`,
      name: "trinkhallen.app",
      description:
        "Trinkhallen, Wasserhäuschen und Spätis in Deutschland — offen, durchsuchbar, von der Community gepflegt.",
      inLanguage: "de-DE",
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${ORIGIN}/#organization`,
      name: "trinkhallen.app",
      url: `${ORIGIN}/`,
      logo: `${ORIGIN}/apple-touch-icon.svg`,
      sameAs: [
        "https://github.com/boredland/trinkhallen-app",
        "https://github.com/boredland/trinkhallen-data",
      ],
    },
  ];
}

/**
 * Render the map page, optionally with the kiosk detail sheet pre-opened.
 *
 * /  → focused = null, sheet closed
 * /k/:id → focused = {kiosk, inner}, sheet open with `inner` content + map
 *          centered on the kiosk. The client sheet.ts reads data-open and
 *          syncs its internal state without re-fetching.
 */
async function renderMapPage(
  c: import("hono").Context<{ Bindings: Env }>,
  focused?: { kiosk: KioskRecord; inner: unknown; href: string; aggregate?: Aggregate | null },
): Promise<Response> {
  const url = new URL(c.req.url);
  const filter = parseFilterFromQuery(url.searchParams);

  // For a focused kiosk we centre the map on it; otherwise the URL ?c=lat,lng
  // or default Frankfurt centre takes over (handled in map.entry.ts).
  const focusLng = focused?.kiosk.lng;
  const focusLat = focused?.kiosk.lat;

  // Side-panel bbox: when focused on a kiosk that's outside Frankfurt, use a
  // box around it so the panel isn't empty on first paint.
  const initialBbox = focused
    ? {
        west: focused.kiosk.lng - 0.05,
        south: focused.kiosk.lat - 0.04,
        east: focused.kiosk.lng + 0.05,
        north: focused.kiosk.lat + 0.04,
      }
    : parseBbox(url.searchParams.get("bbox") ?? "8.4,50.0,8.9,50.3");

  let initialPanel = <KioskList kiosks={[]} totalInBbox={0} filteredCount={0} userAgent={null} />;
  if (initialBbox) {
    const all = await queryKiosksInBbox(c.env, initialBbox, 5000);
    const filtered = applyFilters(all, filter);
    filtered.sort((a, b) => a.name.localeCompare(b.name, "de"));
    const openNowCount = filtered.reduce(
      (n, r) => (computeStatus(r.hours?.raw).kind === "open" ? n + 1 : n),
      0,
    );
    initialPanel = (
      <KioskList
        kiosks={filtered.slice(0, 100)}
        totalInBbox={all.length}
        filteredCount={filtered.length}
        openNowCount={openNowCount}
        filterActive={isFilterActive(filter)}
        resetHref="/"
        userAgent={c.req.header("user-agent") ?? null}
      />
    );
  }

  const sheetOpen = !!focused;
  const title = focused
    ? kioskHeadline(focused.kiosk)
    : "Trinkhallen, Spätis & Wasserhäuschen finden";
  const description = focused
    ? kioskDescription(focused.kiosk)
    : "Karte mit Trinkhallen, Wasserhäuschen und Spätis in ganz Deutschland — gefiltert nach Öffnungszeiten, Zahlung und Tags. Ein Klick zur Navigation.";
  const canonicalUrl = focused ? `${ORIGIN}/k/${focused.kiosk.id}` : `${ORIGIN}/`;
  const jsonLd = focused
    ? [kioskJsonLd(focused.kiosk, focused.aggregate), kioskBreadcrumbJsonLd(focused.kiosk)]
    : homepageJsonLd();

  return c.html(
    <Layout
      title={title}
      description={description}
      canonicalUrl={canonicalUrl}
      jsonLd={jsonLd}
      nav="map"
      clientEntries={["app", "map"]}
      fullBleed
      user={c.get("user")}
    >
      <div class="relative h-full w-full">
        <div
          id="map"
          class="h-full w-full bg-surface"
          data-bbox="5.87,47.27,15.04,55.06"
          data-filter-state={url.search}
          data-focus-lng={focusLng !== undefined ? String(focusLng) : undefined}
          data-focus-lat={focusLat !== undefined ? String(focusLat) : undefined}
        />
        {/* Backdrop is a sibling of the sheet (transform ancestor would make
            position: fixed resolve to its bounds, not the viewport). */}
        <div
          id="kiosk-sheet-backdrop"
          class="pointer-events-none fixed inset-0 z-20 bg-bg/60 opacity-0 transition-opacity duration-200 data-[open=true]:pointer-events-auto data-[open=true]:opacity-100"
          data-open={sheetOpen ? "true" : "false"}
        />
        <div
          id="kiosk-sheet"
          class="pointer-events-none fixed inset-x-0 bottom-0 z-30 translate-y-full transition-transform duration-200 ease-out data-[open=true]:pointer-events-auto data-[open=true]:translate-y-0 sm:top-0 sm:left-auto sm:right-0 sm:w-full sm:max-w-md sm:translate-x-full sm:translate-y-0 sm:data-[open=true]:translate-x-0"
          data-open={sheetOpen ? "true" : "false"}
          data-initial-href={focused?.href}
          aria-hidden={sheetOpen ? "false" : "true"}
        >
          <div class="relative flex max-h-[90dvh] flex-col bg-surface border-t-2 border-border sm:h-full sm:max-h-none sm:border-l-2 sm:border-t-0">
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
            <div id="kiosk-sheet-body" class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {focused?.inner}
            </div>
          </div>
        </div>

        <button
          type="button"
          data-sidebar-expand
          aria-label="Filter einblenden"
          class="pointer-events-auto absolute bottom-3 left-3 z-20 hidden cursor-pointer items-center gap-1.5 border-2 border-border bg-surface px-3 py-2 font-display text-sm tracking-wider uppercase text-fg hover:border-neon-pink hover:text-neon-pink data-[show=true]:flex sm:top-3 sm:bottom-auto"
          data-show="false"
        >
          ☰ Filter
        </button>
        <aside
          data-sidebar
          data-collapsed="false"
          class="pointer-events-auto absolute inset-x-0 bottom-0 z-10 flex max-h-[60dvh] flex-col border-t-2 border-border bg-surface/95 backdrop-blur transition-transform duration-200 ease-out data-[collapsed=true]:translate-y-full sm:top-0 sm:left-0 sm:right-auto sm:max-h-none sm:w-[380px] sm:border-r-2 sm:border-t-0 sm:data-[collapsed=true]:translate-x-[-100%] sm:data-[collapsed=true]:translate-y-0"
        >
          <div class="relative border-b-2 border-border p-3 pr-10">
            <FilterChips filter={filter} formAction="/" />
            {/* Direction-aware glyph: ← on desktop (sidebar slides off left),
                ↓ on mobile (sidebar slides off bottom). Ghost styling keeps
                it out of the way of the filter chips it sits next to. */}
            <button
              type="button"
              data-sidebar-collapse
              aria-label="Filter ausblenden"
              class="absolute right-1 top-1 flex h-8 w-8 cursor-pointer items-center justify-center text-lg leading-none text-fg-dim transition-colors hover:text-neon-pink focus-visible:text-neon-pink focus-visible:outline-2 focus-visible:outline-neon-pink"
            >
              <span class="sm:hidden" aria-hidden="true">
                ↓
              </span>
              <span class="hidden sm:inline" aria-hidden="true">
                ←
              </span>
            </button>
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
}

export function registerPageRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/", async (c) => renderMapPage(c));

  // Legacy redirect — /list was unified into the map sidebar.
  app.get("/list", (c) => c.redirect("/", 301));

  // Per-city directory pages. SERP analysis (see SXO audit) showed that
  // "trinkhallen frankfurt" / "späti berlin" rank curated lists, not maps —
  // /stadt/:slug serves a real list page so we can compete for those.
  app.get("/stadt/:slug", async (c) => {
    const slug = c.req.param("slug");
    const [manifest, kiosks] = await Promise.all([
      loadManifest(c.env),
      kiosksByRegion(c.env, slug),
    ]);
    const region = manifest.regions.find((r) => r.slug === slug);
    if (!region || kiosks.length === 0) {
      return c.html(
        <Layout title="Stadt nicht gefunden" noindex nav="map" user={c.get("user")}>
          <h1 class="font-display text-4xl tracking-wide text-fg">404 — Stadt nicht gefunden</h1>
          <p class="mt-3 text-fg-muted">
            <code class="font-mono">{slug}</code> ist nicht in unserem Datensatz.{" "}
            <a class="text-neon-cyan underline-offset-2 hover:underline" href="/">
              Zurück zur Karte
            </a>
          </p>
        </Layout>,
        404,
      );
    }

    const city = cityDisplayName(slug);
    const total = kiosks.length;
    const sorted = [...kiosks].sort((a, b) => a.name.localeCompare(b.name, "de"));
    const openNowCount = sorted.reduce(
      (n, r) => (computeStatus(r.hours?.raw).kind === "open" ? n + 1 : n),
      0,
    );
    const visible = sorted.slice(0, 100);
    const [w, s, e, n] = region.bbox;
    const centerLat = (s + n) / 2;
    const centerLng = (w + e) / 2;
    const mapHref = `/?c=${centerLat.toFixed(4)},${centerLng.toFixed(4)}&z=12`;

    const itemListJsonLd: object = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: `Trinkhallen, Spätis & Wasserhäuschen in ${city}`,
      numberOfItems: total,
      itemListElement: visible.map((k, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${ORIGIN}/k/${k.id}`,
        name: k.name,
      })),
    };
    const breadcrumbJsonLd: object = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Trinkhallen", item: `${ORIGIN}/` },
        {
          "@type": "ListItem",
          position: 2,
          name: city,
          item: `${ORIGIN}/stadt/${slug}`,
        },
      ],
    };

    return c.html(
      <Layout
        title={`Trinkhallen, Spätis & Wasserhäuschen in ${city}`}
        description={`${total} Trinkhallen, Spätis und Wasserhäuschen in ${city} — mit Öffnungszeiten, Kartenzahlung und Direktnavigation. ${openNowCount} jetzt offen.`}
        canonicalUrl={`${ORIGIN}/stadt/${slug}`}
        jsonLd={[itemListJsonLd, breadcrumbJsonLd]}
        nav="map"
        user={c.get("user")}
      >
        <article class="space-y-6">
          <header>
            <p class="font-display text-sm uppercase tracking-wider text-fg-muted">
              <a class="hover:text-neon-pink" href="/">
                Trinkhallen
              </a>{" "}
              · {city}
            </p>
            <h1 class="mt-2 font-display text-4xl tracking-wide text-fg sm:text-6xl">
              Spätis & Trinkhallen in {city}
            </h1>
            <p class="mt-3 text-lg text-fg-muted">
              {total.toLocaleString("de-DE")} Standorte in {city}.
              {openNowCount > 0 && (
                <>
                  {" "}
                  <span class="text-status-open">▶▶▶ {openNowCount} jetzt offen.</span>
                </>
              )}
            </p>
            <p class="mt-4">
              <a class="btn-neon" href={mapHref}>
                ▶ Auf der Karte ansehen
              </a>
            </p>
          </header>

          <KioskList
            kiosks={visible}
            totalInBbox={total}
            filteredCount={total}
            openNowCount={openNowCount}
            variant="page"
            userAgent={c.req.header("user-agent") ?? null}
          />

          {total > visible.length && (
            <p class="text-sm text-fg-dim">
              {visible.length} von {total.toLocaleString("de-DE")} angezeigt.{" "}
              <a class="text-neon-cyan underline-offset-2 hover:underline" href={mapHref}>
                Alle auf der Karte →
              </a>
            </p>
          )}
        </article>
      </Layout>,
    );
  });

  app.get("/about", async (c) => {
    const [total, ratings] = await Promise.all([countKiosks(c.env), countRatings(c.env)]);
    return c.html(
      <Layout
        title="Über trinkhallen.app"
        description="trinkhallen.app listet Trinkhallen, Spätis und Wasserhäuschen in ganz Deutschland — mit Öffnungszeiten, Kartenzahlung-Filter und Direktnavigation. Daten aus OpenStreetMap und der Community, offen auf GitHub."
        canonicalUrl="https://trinkhallen.app/about"
        nav="about"
        user={c.get("user")}
      >
        <article class="space-y-10">
          <header>
            <h1 class="font-display text-4xl tracking-wide text-fg sm:text-6xl">
              trinkhallen<span class="text-neon-pink">.</span>app
            </h1>
            <p class="mt-3 text-lg text-fg-muted">
              {total.toLocaleString("de-DE")} Trinkhallen, Wasserhäuschen und Spätis in einer Karte.
              Offen, durchsuchbar, von der Community gepflegt — nicht-kommerziell.
            </p>
          </header>

          <section class="grid grid-cols-2 gap-4 sm:gap-6">
            <Metric value={total} label="Trinkhallen kartiert" />
            <Metric value={ratings} label="Bewertungen abgegeben" />
          </section>

          <section>
            <h2 class="font-display text-2xl tracking-wide text-fg">▶▶▶ Was ist das?</h2>
            <p class="mt-3 text-fg-muted">
              Du suchst einen Späti mit Kartenzahlung, der gerade offen hat, und willst direkt hin
              navigieren? Genau dafür ist trinkhallen.app gebaut. Das Projekt ist von{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://app.hopfenstop.de/"
              >
                HopfenStop
              </a>{" "}
              inspiriert und erweitert dessen Frankfurter Datensatz um eine offene Beitrags-Pipeline
              und Daten für ganz Deutschland aus OpenStreetMap.
            </p>
          </section>

          <section>
            <h2 class="font-display text-2xl tracking-wide text-fg">▶▶▶ Daten</h2>
            <p class="mt-3 text-fg-muted">
              Alle Kiosk-Metadaten liegen offen auf GitHub als GeoJSON, mit pro-Eintrag
              Quellenangabe (<code class="font-mono">sources[]</code>):
            </p>
            <ul class="mt-3 space-y-2 text-fg-muted">
              <li>
                <a
                  class="text-neon-cyan underline-offset-2 hover:underline"
                  href="https://github.com/boredland/trinkhallen-data"
                >
                  boredland/trinkhallen-data
                </a>{" "}
                — der Datensatz. PRs willkommen.
              </li>
              <li>
                <a
                  class="text-neon-cyan underline-offset-2 hover:underline"
                  href="https://github.com/boredland/trinkhallen-app"
                >
                  boredland/trinkhallen-app
                </a>{" "}
                — Code (Cloudflare Workers + Hono).
              </li>
            </ul>
            <p class="mt-3 text-sm text-fg-dim">
              <strong>Quellen:</strong> HopfenStop (Frankfurt-Seed,{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://creativecommons.org/licenses/by-nc/4.0/"
              >
                CC BY-NC 4.0
              </a>
              ) · OpenStreetMap (
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://www.openstreetmap.org/copyright"
              >
                ODbL
              </a>
              ) · Beiträge der Nutzer:innen.
            </p>
          </section>

          <section>
            <h2 class="font-display text-2xl tracking-wide text-fg">▶▶▶ Mitmachen</h2>
            <ul class="mt-3 space-y-3 text-fg-muted">
              <li>
                <span class="font-display text-fg">Bewerten:</span> 1–5 Sterne + optionaler
                Kommentar auf jeder Detailseite (Login nötig).
              </li>
              <li>
                <span class="font-display text-fg">Korrigieren:</span> „Daten falsch?"-Knopf auf der
                Detailseite → öffnet ein GitHub-Issue zur Moderation.
              </li>
              <li>
                <span class="font-display text-fg">Vorschlagen:</span>{" "}
                <a class="text-neon-cyan underline-offset-2 hover:underline" href="/add">
                  /add
                </a>{" "}
                → Späti auf der Karte anklicken, Adresse + Öffnungszeiten + Zahlung eintragen.
              </li>
              <li>
                <span class="font-display text-fg">Direkt PR auf GitHub:</span> Wer mag, kann den
                Datensatz auch direkt forken und PRs gegen{" "}
                <a
                  class="text-neon-cyan underline-offset-2 hover:underline"
                  href="https://github.com/boredland/trinkhallen-data"
                >
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
              <strong class="text-fg">Daten:</strong> CC BY-NC 4.0 — frei zum Teilen und Anpassen,
              mit Attribution, nicht-kommerziell.
              <br />
              <strong class="text-fg">Code:</strong> AGPL-3.0-or-later.
            </p>
          </section>

          <section>
            <h2 class="font-display text-2xl tracking-wide text-fg">▶▶▶ Betreiber</h2>
            <p class="mt-3 text-fg-muted">
              trinkhallen.app wird von{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://github.com/boredland"
              >
                Jonas (boredland)
              </a>{" "}
              als nicht-kommerzielles Open-Source-Projekt betrieben. Kontakt &amp; Issues über{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://github.com/boredland/trinkhallen-app/issues"
              >
                GitHub
              </a>
              .
            </p>
          </section>

          <footer class="pt-4 text-xs text-fg-dim">
            Bugs &amp; Wünsche →{" "}
            <a
              class="text-neon-cyan underline-offset-2 hover:underline"
              href="https://github.com/boredland/trinkhallen-app/issues"
            >
              GitHub Issues
            </a>
            .
          </footer>
        </article>
      </Layout>,
    );
  });

  app.get("/k/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    const partial = c.req.query("partial") === "1";
    const kiosk = await getKioskById(c.env, id);
    if (!kiosk) {
      if (partial) return c.text("not found", 404);
      return c.html(
        <Layout title="Nicht gefunden" noindex nav="map" user={user}>
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
    const [aggregate, ownRating, nearbyHits] = await Promise.all([
      getAggregate(c.env, kiosk.id),
      user ? getOwnRating(c.env, kiosk.id, user.id) : Promise.resolve(null),
      findNearbyKiosks(c.env, { lat: kiosk.lat, lng: kiosk.lng }, kiosk.id, 5),
    ]);
    const nearby = nearbyHits.map(({ record, distance }) => ({
      id: record.id,
      name: record.name,
      district: record.address["district"],
      distance,
      lng: record.lng,
      lat: record.lat,
    }));
    const detail = (
      <KioskDetail
        kiosk={kiosk}
        userAgent={c.req.header("user-agent") ?? null}
        aggregate={aggregate}
        ownRating={ownRating}
        isLoggedIn={!!user}
        nearby={nearby}
      />
    );
    // ?partial=1 → bare HTML the client sheet fetches when an in-app
    // map click opens the detail sheet over the map.
    if (partial) return c.html(detail);

    // Direct /k/:id GET → standalone "place page". The article is the
    // primary semantic element rather than an overlay on a map; this is
    // the URL crawlers, AI retrieval bots, and shared-link recipients
    // hit. The in-app sheet flow still uses ?partial=1 (above), so the
    // map experience is unaffected for clicks inside the app.
    const city = kiosk.address["city"];
    return c.html(
      <Layout
        title={kioskHeadline(kiosk)}
        description={kioskDescription(kiosk)}
        canonicalUrl={`${ORIGIN}/k/${kiosk.id}`}
        jsonLd={[kioskJsonLd(kiosk, aggregate), kioskBreadcrumbJsonLd(kiosk)]}
        nav="map"
        user={user}
      >
        <p class="mb-4 font-display text-sm uppercase tracking-wider text-fg-muted">
          <a class="hover:text-neon-pink" href="/">
            Trinkhallen
          </a>
          {city && (
            <>
              {" · "}
              <a class="hover:text-neon-pink" href={`/stadt/${kiosk.region.split("/").pop()}`}>
                {cityDisplayName(kiosk.region.split("/").pop() ?? "")}
              </a>
            </>
          )}
        </p>
        {detail}
        <p class="mt-4">
          <a
            class="text-neon-cyan underline-offset-2 hover:underline"
            href={`/?c=${kiosk.lat.toFixed(4)},${kiosk.lng.toFixed(4)}&z=16`}
          >
            ▶ Auf der Karte ansehen
          </a>
        </p>
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
    return c.html(
      <Layout
        title="Späti hinzufügen"
        noindex
        nav="map"
        user={user}
        clientEntries={["app", "pick"]}
      >
        <header class="mb-6">
          <h1 class="font-display text-4xl tracking-wide text-fg">Späti vorschlagen</h1>
          <p class="mt-2 text-fg-muted">
            Dein Vorschlag landet als Pull Request auf{" "}
            <a
              class="text-neon-cyan underline-offset-2 hover:underline"
              href="https://github.com/boredland/trinkhallen-data"
            >
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
            <div id="pick-map" class="h-72 w-full border-2 border-border-hi bg-bg sm:h-96" />
            <p class="text-xs text-fg-dim">
              ▶ Klick auf die Karte, um die genaue Position zu setzen. Geolokalisierung
              (Pfeil-Symbol oben rechts) füllt automatisch ein.
            </p>
            <div class="grid grid-cols-2 gap-3">
              <label>
                <span class="block text-xs uppercase tracking-wider text-fg-dim">
                  Breitengrad (lat)
                </span>
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
                <span class="block text-xs uppercase tracking-wider text-fg-dim">
                  Längengrad (lng)
                </span>
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
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">
              Name &amp; Adresse
            </legend>
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
            <input
              type="text"
              name="street"
              placeholder="Straße"
              class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
            />
            <div class="grid grid-cols-3 gap-3">
              <input
                type="text"
                name="number"
                placeholder="Nr"
                class="border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
              />
              <input
                type="text"
                name="postalcode"
                placeholder="PLZ"
                maxLength={5}
                class="border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
              />
              <input
                type="text"
                name="city"
                placeholder="Stadt"
                class="border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
              />
            </div>
            <input
              type="text"
              name="district"
              placeholder="Stadtteil"
              class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
            />
          </fieldset>

          <fieldset class="space-y-2">
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">
              Beschreibung
            </legend>
            <textarea
              name="description"
              rows={3}
              maxLength={2000}
              placeholder="Was macht den Späti besonders?"
              class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
            />
          </fieldset>

          <fieldset class="space-y-2">
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">
              Öffnungszeiten
            </legend>
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
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">
              Zahlung
            </legend>
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(["cash", "cards", "contactless", "girocard", "mobile"] as const).map((key) => (
                <label class="flex items-center gap-2 border-2 border-border bg-surface-2 px-2 py-1.5 text-sm">
                  <span class="flex-1 capitalize text-fg-muted">{key}</span>
                  <select name={`pay_${key}`} class="bg-transparent text-fg focus:outline-none">
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
            <legend class="font-display text-sm tracking-wider uppercase text-fg-muted">
              Tags
            </legend>
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
        <Layout title="Anmelden" noindex nav="me" user={undefined}>
          <section class="border-2 border-border bg-surface p-8">
            <h1 class="font-display text-3xl tracking-wide text-fg sm:text-4xl">Anmelden</h1>
            <p class="mt-3 text-fg-muted">
              Anmelden, um Spätis zu bewerten und Korrekturen einzureichen. Anonyme Nutzung der
              Karte bleibt jederzeit möglich.
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

            <form
              action="/auth/magic"
              method="post"
              class="mt-6 flex flex-col gap-3 sm:flex-row sm:items-stretch"
            >
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
    c.env.DB.prepare(
      `SELECT r.id, r.kiosk_id, r.kind, r.status, r.pr_url, r.created_at
         FROM reports r
         WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 50`,
    )
      .bind(user.id)
      .all<Omit<ReportListRow, "kiosk_name">>(),
    c.env.DB.prepare(
      `SELECT id, payload, status, pr_url, created_at FROM submissions
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
      .bind(user.id)
      .all<SubmissionListRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ratings WHERE user_id = ?`)
      .bind(user.id)
      .first<{ n: number }>(),
  ]);

  const reportRows = reportsRes.results;
  const kioskNames = new Map<string, string>();
  await Promise.all(
    [...new Set(reportRows.map((r) => r.kiosk_id))].map(async (id) => {
      const k = await getKioskById(c.env, id);
      if (k) kioskNames.set(id, k.name);
    }),
  );
  const reports: ReportListRow[] = reportRows.map((r) => ({
    ...r,
    kiosk_name: kioskNames.get(r.kiosk_id) ?? r.kiosk_id,
  }));
  const submissions = submissionsRes.results;
  const ratingsCount = ratingsCountRow?.n ?? 0;
  const fmtDate = (s: number) => new Date(s * 1000).toLocaleDateString("de-DE");

  return c.html(
    <Layout title="Profil" noindex nav="me" user={user}>
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
            <p class="mt-1 text-xs uppercase tracking-wider text-fg-dim">Rolle: {user.role}</p>
          </div>
        </div>
        <dl class="mt-6 grid grid-cols-3 gap-3 text-center">
          <Stat n={ratingsCount} label="Bewertungen" />
          <Stat n={reports.length} label="Korrekturen" />
          <Stat n={submissions.length} label="Vorschläge" />
        </dl>
        <form action="/auth/logout" method="post" class="mt-6">
          <button
            type="submit"
            class="border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wide text-fg-muted transition-colors hover:border-neon-pink hover:text-neon-pink"
          >
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
          <a
            href="/add"
            class="border-2 border-border-hi px-2 py-1 font-display text-xs tracking-wider uppercase text-fg-muted hover:border-neon-pink hover:text-neon-pink"
          >
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

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div class="border-2 border-border bg-surface px-5 py-6 sm:px-6 sm:py-8">
      <div class="font-display text-5xl text-neon-pink tabular-nums sm:text-6xl">
        {value.toLocaleString("de-DE")}
      </div>
      <div class="mt-2 text-sm uppercase tracking-wider text-fg-dim">{label}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { de: string; cls: string }> = {
    open: { de: "Offen", cls: "border-status-open text-status-open" },
    pending: { de: "Wartet", cls: "border-status-open text-status-open" },
    pr_opened: { de: "PR offen", cls: "border-neon-cyan text-neon-cyan" },
    merged: { de: "Übernommen", cls: "border-success text-success" },
    dismissed: { de: "Verworfen", cls: "border-border text-fg-dim" },
  };
  const cfg = map[status] ?? { de: status, cls: "border-border text-fg-dim" };
  return <span class={`border-2 px-2 py-0.5 ${cfg.cls}`}>{cfg.de}</span>;
}
