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
import { parseBbox, parseLatLng } from "../lib/geo";
import { computeStatus, kioskLocation } from "../lib/opening-hours";
import type { Aggregate } from "../lib/ratings";
import { countRatings, getAggregate, getOwnRating } from "../lib/ratings";
import { getUserReports, kindLabel } from "../lib/reports";
import { destroySession } from "../lib/session";
import { setUsername } from "../lib/usernames";
import { countUsers } from "../lib/users";

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

  // Side-panel bbox resolution, in priority order:
  //   1. focused kiosk → box around it
  //   2. ?bbox=w,s,e,n → exact (canonical share-URL shape)
  //   3. ?c=lat,lng → ~5 km box around the centre, so deep links into
  //      Berlin/Köln/etc render with the right city's kiosks in the
  //      sidebar instead of the Frankfurt default. Mirrors what
  //      map.entry.ts does for the map element.
  //   4. Frankfurt fallback.
  const centerHint = parseLatLng(url.searchParams.get("c"));
  const initialBbox = focused
    ? {
        west: focused.kiosk.lng - 0.05,
        south: focused.kiosk.lat - 0.04,
        east: focused.kiosk.lng + 0.05,
        north: focused.kiosk.lat + 0.04,
      }
    : (parseBbox(url.searchParams.get("bbox")) ??
      (centerHint
        ? {
            west: centerHint.lng - 0.05,
            south: centerHint.lat - 0.04,
            east: centerHint.lng + 0.05,
            north: centerHint.lat + 0.04,
          }
        : parseBbox("8.4,50.0,8.9,50.3")));

  let initialPanel = <KioskList kiosks={[]} totalInBbox={0} filteredCount={0} userAgent={null} />;
  if (initialBbox) {
    const all = await queryKiosksInBbox(c.env, initialBbox, 5000);
    const filtered = applyFilters(all, filter);
    filtered.sort((a, b) => a.name.localeCompare(b.name, "de"));
    const now = new Date();
    const openNowCount = filtered.reduce(
      (n, r) => (computeStatus(r.hours?.raw, now, kioskLocation(r)).kind === "open" ? n + 1 : n),
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
        {/* Legal footer overlay — fullBleed hides the global Footer, but TMG
            §5 expects the Impressum to be reachable from every page. Sits
            bottom-left so it doesn't collide with MapLibre's attribution
            control at bottom-right. */}
        <nav class="pointer-events-none absolute bottom-2 left-2 z-10 flex gap-3 text-xs text-fg-dim/80">
          <a
            class="pointer-events-auto bg-bg/70 px-1.5 py-0.5 backdrop-blur-sm hover:text-neon-cyan"
            href="/impressum"
          >
            Impressum
          </a>
          <a
            class="pointer-events-auto bg-bg/70 px-1.5 py-0.5 backdrop-blur-sm hover:text-neon-cyan"
            href="/datenschutz"
          >
            Datenschutz
          </a>
        </nav>
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
          class="pointer-events-auto absolute inset-x-0 bottom-0 z-10 max-h-[80dvh] overflow-y-auto overscroll-contain border-t-2 border-border bg-surface/95 backdrop-blur transition-transform duration-200 ease-out [touch-action:pan-y] data-[collapsed=true]:translate-y-full sm:top-0 sm:left-0 sm:right-auto sm:max-h-none sm:w-[380px] sm:border-r-2 sm:border-t-0 sm:data-[collapsed=true]:translate-x-[-100%] sm:data-[collapsed=true]:translate-y-0"
        >
          <div class="sticky top-0 z-10 border-b-2 border-border bg-surface p-3 pr-10">
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

  // PWA shortcut destination — "find the nearest currently-open kiosk and
  // open native Maps for navigation". Requires browser geolocation; the
  // page below holds the user-gesture flow that pre-permission iOS Safari
  // needs and degrades gracefully to the map on denial or no-results.
  app.get("/jetzt", (c) =>
    c.html(
      <Layout
        title="Jetzt navigieren"
        description="Direkt zum nächsten geöffneten Späti per Karten-App."
        noindex
        nav="map"
        user={c.get("user")}
      >
        <article class="border-2 border-border bg-surface p-6">
          <h1 class="font-display text-3xl tracking-wide text-fg sm:text-4xl">Jetzt navigieren</h1>
          <p id="jetzt-status" class="mt-4 text-fg-muted" aria-live="polite">
            Wir holen kurz deinen Standort, suchen den nächsten geöffneten Späti und öffnen deine
            Karten-App.
          </p>
          <div id="jetzt-actions" class="mt-6 hidden flex-col gap-3 sm:flex-row sm:flex-wrap">
            <a href="/" class="btn-neon">
              Zur Karte
            </a>
            <button type="button" id="jetzt-retry" class="btn-neon">
              Erneut versuchen
            </button>
          </div>
        </article>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (() => {
                const status = document.getElementById("jetzt-status");
                const actions = document.getElementById("jetzt-actions");
                const retry = document.getElementById("jetzt-retry");
                const setMsg = (m) => { if (status) status.textContent = m; };
                const showFallback = () => {
                  if (actions) {
                    actions.classList.remove("hidden");
                    actions.classList.add("flex");
                  }
                };
                const go = () => {
                  if (!("geolocation" in navigator)) {
                    setMsg("Dein Browser unterstützt keine Standort-Anfrage. Öffne die Karte und such manuell.");
                    showFallback();
                    return;
                  }
                  setMsg("Standort wird ermittelt …");
                  navigator.geolocation.getCurrentPosition(async (pos) => {
                    const { latitude: lat, longitude: lng } = pos.coords;
                    setMsg("Suche den nächsten geöffneten Späti …");
                    try {
                      const res = await fetch(\`/api/kiosks/nearest-open?origin=\${lat},\${lng}\`);
                      if (res.status === 404) {
                        setMsg("In deiner Nähe ist gerade nichts geöffnet. Schau auf die Karte für die volle Übersicht.");
                        showFallback();
                        return;
                      }
                      if (!res.ok) throw new Error("nearest lookup failed");
                      const data = await res.json();
                      setMsg(\`\${data.name} — Karten-App wird geöffnet …\`);
                      window.location.href = data.nav_url;
                    } catch {
                      setMsg("Konnte den nächsten Späti nicht ermitteln. Öffne die Karte manuell.");
                      showFallback();
                    }
                  }, () => {
                    setMsg("Wir konnten deinen Standort nicht lesen. Öffne die Karte und navigiere von dort.");
                    showFallback();
                  }, { enableHighAccuracy: true, timeout: 8000 });
                };
                retry?.addEventListener("click", go);
                go();
              })();
            `,
          }}
        />
      </Layout>,
    ),
  );

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
    const cityNow = new Date();
    const openNowCount = sorted.reduce(
      (n, r) =>
        computeStatus(r.hours?.raw, cityNow, kioskLocation(r)).kind === "open" ? n + 1 : n,
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
    const [total, ratings, users] = await Promise.all([
      countKiosks(c.env),
      countRatings(c.env),
      countUsers(c.env),
    ]);
    return c.html(
      <Layout
        title="Über trinkhallen.app"
        description="trinkhallen.app ist der offene Nachfolger von HopfenStop — Trinkhallen, Spätis und Wasserhäuschen in ganz Deutschland mit Öffnungszeiten, Kartenzahlung-Filter und Direktnavigation. Daten aus OpenStreetMap und der Community, offen auf GitHub."
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

          <section class="grid grid-cols-2 gap-4 sm:gap-6 md:grid-cols-3">
            <Metric value={total} label="Trinkhallen kartiert" />
            <Metric value={ratings} label="Bewertungen abgegeben" />
            <Metric value={users} label="Registrierte Personen" />
          </section>

          <section>
            <h2 class="font-display text-2xl tracking-wide text-fg">▶▶▶ Was ist das?</h2>
            <p class="mt-3 text-fg-muted">
              Du suchst einen Späti mit Kartenzahlung, der gerade offen hat, und willst direkt hin
              navigieren? Genau dafür ist trinkhallen.app gebaut.
            </p>
            <p class="mt-3 text-fg-muted">
              trinkhallen.app ist der offene Nachfolger von{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://app.hopfenstop.de/"
              >
                HopfenStop
              </a>
              . Der sorgfältig kuratierte Frankfurter Datensatz von HopfenStop bildet die Basis und
              lebt hier weiter — ergänzt um OpenStreetMap-Daten für ganz Deutschland, eine
              transparente Beitrags-Pipeline auf GitHub und Pflege durch die Community statt durch
              eine einzelne Person.
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
                <span class="font-display text-fg">Warst du hier?</span> Auf der Detailseite mit
                einem Tap einchecken — wenn Daten fehlen (Öffnungszeiten, Zahlung, Sitzen, WC, …),
                fragt das Formular kurz nach. Antworten gehen durch Moderation und landen im offenen
                Datensatz.
              </li>
              <li>
                <span class="font-display text-fg">Korrigieren:</span> „Daten falsch?"-Bereich deckt
                geschlossen, doppelter Eintrag, falsche Adresse usw. ab. Moderation prüft und
                übernimmt die Korrektur in den Datensatz.
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
              <li>Cloudflare Workers · Hono SSR · TypeScript · D1 (SQLite)</li>
              <li>MapLibre GL JS · OpenFreeMap (Vektor-Tiles, ohne API-Key)</li>
              <li>Tailwind CSS v4 · Anton / Inter · keine Tracker, kein Analytics</li>
              <li>
                Auth: Magic-Link per Mail (Cloudflare Email Routing) oder Google SSO — mit
                automatischem Merge der beiden bei gleicher Adresse.
              </li>
              <li>
                Wöchentliches OSM-Ingest + Daten-Anreicherung (Öffnungszeiten, Zahlung, Place-IDs)
                per GitHub Actions Pipeline.
              </li>
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

  app.get("/impressum", (c) =>
    c.html(
      <Layout
        title="Impressum"
        description="Impressum von trinkhallen.app — Angaben gemäß §5 TMG."
        canonicalUrl="https://trinkhallen.app/impressum"
        nav="about"
        user={c.get("user")}
      >
        <article class="space-y-8">
          <header>
            <h1 class="font-display text-4xl tracking-wide text-fg sm:text-5xl">Impressum</h1>
            <p class="mt-3 text-fg-muted">Angaben gemäß § 5 TMG</p>
          </header>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Betreiber</h2>
            <address class="mt-3 not-italic text-fg-muted">
              Jonas Strassel
              <br />
              Am Kappelgarten 24
              <br />
              60389 Frankfurt am Main
              <br />
              Deutschland
            </address>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Kontakt</h2>
            <p class="mt-3 text-fg-muted">
              E-Mail:{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="mailto:feedback@trinkhallen.app"
              >
                feedback@trinkhallen.app
              </a>
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">
              Verantwortlich für den Inhalt
            </h2>
            <p class="mt-3 text-fg-muted">
              Jonas Strassel (Anschrift wie oben). trinkhallen.app ist ein nicht-kommerzielles
              Open-Source-Projekt; der Datensatz lebt in einem öffentlichen{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://github.com/boredland/trinkhallen-data"
              >
                GitHub-Repository
              </a>{" "}
              und wird von der Community gepflegt.
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Haftung für Inhalte</h2>
            <p class="mt-3 text-fg-muted">
              Die Inhalte dieser Seite wurden mit größtmöglicher Sorgfalt erstellt. Für die
              Richtigkeit, Vollständigkeit und Aktualität der Kiosk-Daten (Öffnungszeiten,
              Zahlungsmethoden, Standort etc.) kann jedoch keine Gewähr übernommen werden — sie
              stammen aus offenen Quellen (OpenStreetMap, Community-Beiträge) und können veraltet
              sein.
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Haftung für Links</h2>
            <p class="mt-3 text-fg-muted">
              Diese Seite enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen
              Einfluss haben. Für diese fremden Inhalte ist stets der jeweilige Anbieter
              verantwortlich. Bei Bekanntwerden von Rechtsverletzungen werden entsprechende Links
              umgehend entfernt.
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Urheberrecht</h2>
            <p class="mt-3 text-fg-muted">
              Der Quellcode dieser Anwendung steht unter{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://www.gnu.org/licenses/agpl-3.0.de.html"
              >
                AGPL-3.0-or-later
              </a>
              , der Datensatz unter{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://creativecommons.org/licenses/by-nc/4.0/deed.de"
              >
                CC BY-NC 4.0
              </a>
              . Kartendaten © OpenStreetMap-Mitwirkende (
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://www.openstreetmap.org/copyright"
              >
                ODbL
              </a>
              ).
            </p>
          </section>
        </article>
      </Layout>,
    ),
  );

  app.get("/datenschutz", (c) =>
    c.html(
      <Layout
        title="Datenschutz"
        description="Datenschutzerklärung von trinkhallen.app — welche Daten wir verarbeiten, warum, und wie du deine Rechte ausübst."
        canonicalUrl="https://trinkhallen.app/datenschutz"
        nav="about"
        user={c.get("user")}
      >
        <article class="space-y-8">
          <header>
            <h1 class="font-display text-4xl tracking-wide text-fg sm:text-5xl">
              Datenschutzerklärung
            </h1>
            <p class="mt-3 text-fg-muted">
              Wir speichern so wenig wie möglich. Keine Tracker, kein Analytics, keine Werbung. Was
              wir verarbeiten und warum, steht hier vollständig.
            </p>
          </header>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Verantwortlicher</h2>
            <address class="mt-3 not-italic text-fg-muted">
              Jonas Strassel
              <br />
              Am Kappelgarten 24
              <br />
              60389 Frankfurt am Main
              <br />
              E-Mail:{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="mailto:feedback@trinkhallen.app"
              >
                feedback@trinkhallen.app
              </a>
            </address>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Anonyme Nutzung der Karte</h2>
            <p class="mt-3 text-fg-muted">
              Du kannst die Karte vollständig anonym benutzen — ohne Konto, ohne Login. Beim Aufruf
              der Seite werden technisch unvermeidbare Daten (IP-Adresse, User-Agent, angeforderte
              URL) in den Server-Logs unseres Hosters Cloudflare protokolliert. Rechtsgrundlage:
              Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an Betrieb und Sicherheit der
              Seite). Speicherdauer: maximal 30 Tage.
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">
              Login per E-Mail (Magic Link)
            </h2>
            <p class="mt-3 text-fg-muted">
              Wenn du dich per Magic-Link anmeldest, speichern wir deine E-Mail-Adresse, eine
              gehashte Version des Einmal-Tokens sowie IP-Adresse und User-Agent (für
              Missbrauchsschutz). Der Token wird nach Einlösung oder spätestens 15 Minuten ungültig.
              Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Durchführung des Nutzungsverhältnisses).
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Login per Google</h2>
            <p class="mt-3 text-fg-muted">
              Wenn du dich per Google anmeldest, erhalten wir von Google deine E-Mail-Adresse,
              deinen Namen, dein Profilbild und eine stabile interne ID. Bei der Weiterleitung zu
              Google teilt dein Browser deine IP-Adresse mit Google. Wir verarbeiten die Daten
              ausschließlich, um dich wiederzuerkennen und dir deine Inhalte (Bewertungen,
              Korrekturen, Check-ins) zuzuordnen. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO; die
              Datenübermittlung an Google erfolgt nur, wenn du den Login aktiv anstößt.
            </p>
            <p class="mt-3 text-fg-muted">
              Anbieter: Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland.
              Datenschutz:{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://policies.google.com/privacy"
              >
                policies.google.com/privacy
              </a>
              .
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Sitzungs-Cookie</h2>
            <p class="mt-3 text-fg-muted">
              Bist du eingeloggt, setzen wir ein einziges Sitzungs-Cookie (
              <code class="font-mono">__Host-tk_sess</code>
              ), das eine zufällige, kryptographisch signierte ID enthält. Es ist
              <code class="font-mono"> HttpOnly</code>, <code class="font-mono">Secure</code> und
              läuft nach 30 Tagen ohne Aktivität ab. Wir verwenden keine Tracking- oder
              Marketing-Cookies. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (für den Betrieb
              technisch notwendig).
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Eigene Beiträge</h2>
            <p class="mt-3 text-fg-muted">
              Bewertungen, Daten-Korrekturen, Späti-Vorschläge und Check-ins werden mit deinem
              Nutzerkonto verknüpft gespeichert. Freigegebene Korrekturen und Vorschläge werden
              außerdem in den öffentlichen, offen lizenzierten Datensatz{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://github.com/boredland/trinkhallen-data"
              >
                trinkhallen-data
              </a>{" "}
              übernommen und sind dort dauerhaft Teil der offenen Geschichte. Mit dem Eintrag
              gespeichert wird eine zufällige UUID ohne Personenbezug für Außenstehende.
              Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">
              Drittanbieter &amp; Datenübermittlung
            </h2>
            <ul class="mt-3 space-y-3 text-fg-muted">
              <li>
                <strong class="text-fg">Cloudflare</strong> (Workers, D1-Datenbank, Edge-Cache):
                Hosting der Anwendung. Standort: weltweit. Auftragsverarbeitungsvertrag (DPA) und
                Standardvertragsklauseln liegen vor.
              </li>
              <li>
                <strong class="text-fg">Google</strong>: nur wenn du den Google-Login nutzt (siehe
                oben).
              </li>
              <li>
                <strong class="text-fg">OpenFreeMap</strong>: liefert die Kartenkacheln. Beim
                Anzeigen der Karte teilt dein Browser deine IP-Adresse mit OpenFreeMap, um die
                Kacheln auszuliefern. Anbieter:{" "}
                <a
                  class="text-neon-cyan underline-offset-2 hover:underline"
                  href="https://openfreemap.org/"
                >
                  openfreemap.org
                </a>
                .
              </li>
              <li>
                <strong class="text-fg">Photon (Komoot)</strong>: füllt auf <code>/add</code> die
                Adresse aus deiner gewählten Kartenposition vor. Dein Browser sendet die Koordinaten
                an Photon (basiert auf OpenStreetMap-Daten), die IP-Adresse ist technisch
                unvermeidbar. Anbieter: Komoot GmbH;{" "}
                <a
                  class="text-neon-cyan underline-offset-2 hover:underline"
                  href="https://photon.komoot.io/"
                >
                  photon.komoot.io
                </a>
                .
              </li>
            </ul>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Speicherdauer</h2>
            <p class="mt-3 text-fg-muted">
              Konto- und Beitragsdaten bleiben gespeichert, solange dein Konto besteht. Lösche dein
              Konto, indem du eine kurze Mail an die oben genannte Adresse schickst — wir löschen es
              innerhalb von 14 Tagen. Server-Logs werden nach maximal 30 Tagen automatisch
              verworfen. Magic-Link-Token sind nach Einlösung oder 15 Minuten ungültig.
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Deine Rechte</h2>
            <p class="mt-3 text-fg-muted">
              Du hast jederzeit das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16),
              Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit
              (Art. 20) und Widerspruch (Art. 21). Eine kurze Mail an{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="mailto:feedback@trinkhallen.app"
              >
                feedback@trinkhallen.app
              </a>{" "}
              reicht.
            </p>
            <p class="mt-3 text-fg-muted">
              Außerdem hast du das Recht, dich bei einer Datenschutz-Aufsichtsbehörde zu beschweren
              — für uns zuständig:{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://datenschutz.hessen.de/"
              >
                Der Hessische Beauftragte für Datenschutz und Informationsfreiheit
              </a>
              .
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">
              Android-App (Trusted Web Activity)
            </h2>
            <p class="mt-3 text-fg-muted">
              Die Android-App im Google Play Store (
              <code class="font-mono">app.trinkhallen.twa</code>) ist eine{" "}
              <em>Trusted Web Activity</em> — technisch lädt sie ausschließlich diese Website in
              einem Vollbild-Browser-Container von Chrome. Es gibt keinen separaten App-Datenpfad,
              keine zusätzlichen Tracker und keine über die oben beschriebenen Datenflüsse
              hinausgehende Verarbeitung. Alle hier genannten Regeln zu Logging, Login, Cookies und
              Beiträgen gelten für die App identisch.
            </p>
            <p class="mt-3 text-fg-muted">
              Unabhängig davon erhebt Google Play beim Installieren, Aktualisieren oder
              Deinstallieren der App technische Telemetrie (Geräte- und Android-Version, Land,
              optionale Absturzberichte). Auf diese Daten haben wir keinen direkten Zugriff; sie
              unterliegen den{" "}
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href="https://policies.google.com/privacy"
              >
                Google-Datenschutzbestimmungen
              </a>
              . Push-Benachrichtigungen sind aktuell nicht aktiviert.
            </p>
          </section>

          <section>
            <h2 class="font-display text-xl tracking-wide text-fg">Änderungen</h2>
            <p class="mt-3 text-fg-muted">
              Diese Erklärung kann sich ändern, wenn wir das Angebot weiterentwickeln. Der jeweils
              aktuelle Stand steht hier. Wesentliche Änderungen kündigen wir vor Inkrafttreten an.
            </p>
          </section>
        </article>
      </Layout>,
    ),
  );

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
    const [aggregate, ownRating, nearbyHits, userReports] = await Promise.all([
      getAggregate(c.env, kiosk.id),
      user ? getOwnRating(c.env, kiosk.id, user.id) : Promise.resolve(null),
      findNearbyKiosks(c.env, { lat: kiosk.lat, lng: kiosk.lng }, kiosk.id, 5),
      user ? getUserReports(c.env, kiosk.id, user.id) : Promise.resolve([]),
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
        userReports={userReports}
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
            Dein Vorschlag wird von Moderator:innen geprüft und landet anschließend im offenen
            Datensatz.
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
              (Pfeil-Symbol oben rechts) füllt automatisch ein. Adresse wird aus der Kartenposition
              vorbefüllt — du kannst sie überschreiben.
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

            <a
              href="/auth/apple"
              class="mt-6 inline-flex w-full items-center justify-center gap-3 border-2 border-border-hi bg-surface-2 px-3 py-2.5 font-display tracking-wider uppercase text-fg transition-colors hover:border-neon-pink hover:text-neon-pink"
            >
              <span aria-hidden="true">▶</span>
              Mit Apple anmelden
            </a>

            <a
              href="/auth/google"
              class="mt-3 inline-flex w-full items-center justify-center gap-3 border-2 border-border-hi bg-surface-2 px-3 py-2.5 font-display tracking-wider uppercase text-fg transition-colors hover:border-neon-pink hover:text-neon-pink"
            >
              <span aria-hidden="true">▶</span>
              Mit Google anmelden
            </a>

            <div class="my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-fg-dim">
              <span class="h-px flex-1 bg-border" aria-hidden="true" />
              oder
              <span class="h-px flex-1 bg-border" aria-hidden="true" />
            </div>

            <form
              action="/auth/magic"
              method="post"
              class="flex flex-col gap-3 sm:flex-row sm:items-stretch"
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
              Wir speichern nur deine E-Mail-Adresse. Mehr nicht. Mit Google angemeldet, holen wir
              dein Profilbild dazu — kannst du jederzeit wieder lösen.
            </p>
          </section>
        </Layout>,
      );
    }
    return renderProfile(c, user);
  });

  // Set-once username. The handler enforces validation + UNIQUE + IS NULL at
  // the SQL layer; the form on /me only renders when the column is null.
  app.post("/me/username", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/me");
    if (user.username) return c.redirect("/me?username=already_set");
    const raw = ((await c.req.formData()).get("username") ?? "").toString();
    const result = await setUsername(c.env.DB, user.id, raw);
    return c.redirect(`/me?username=${result}`);
  });

  // Account deletion. Hard-cascades personal data; anonymizes contributions
  // that already shipped to trinkhallen-data so the merged PRs stay intact
  // but the link back to the real person is severed.
  app.post("/me/delete", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/me");
    const form = await c.req.formData();
    if ((form.get("confirm") ?? "").toString() !== "yes") {
      return c.redirect("/me?delete=unconfirmed");
    }
    await deleteAccount(c.env.DB, user.id, user.email);
    await destroySession(c);
    // Purge the SW runtime cache before the client navigates, same trick as
    // logout — otherwise the cached logged-in shell flashes back.
    return c.redirect("/?deleted=ok");
  });
}

const DELETED_USER_SENTINEL = "00000000-0000-0000-0000-000000000000";

async function deleteAccount(db: D1Database, userId: string, email: string): Promise<void> {
  // 1. Anonymize contributions that have already escaped D1 (a PR was opened
  //    or merged on trinkhallen-data). We can't unmerge those, but we can
  //    sever the user_id link so the audit trail no longer identifies anyone.
  await db
    .prepare(
      `UPDATE reports SET user_id = ?
         WHERE user_id = ? AND status IN ('pr_opened', 'merged')`,
    )
    .bind(DELETED_USER_SENTINEL, userId)
    .run();
  await db
    .prepare(
      `UPDATE submissions SET user_id = ?
         WHERE user_id = ? AND status IN ('pr_opened', 'merged')`,
    )
    .bind(DELETED_USER_SENTINEL, userId)
    .run();
  // 2. Hard-delete the remaining personal data. Ratings, sessions, and
  //    check-ins CASCADE on the users row, but we explicit-delete them too
  //    so the order is unambiguous and resilient if a later migration
  //    changes the FK shape.
  await db.prepare(`DELETE FROM reports WHERE user_id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM submissions WHERE user_id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM ratings WHERE user_id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM checkins WHERE user_id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM magic_links WHERE email = ?`).bind(email).run();
  // 3. Finally the users row itself.
  await db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
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
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: "user" | "moderator" | "admin";
  isMagicLinkOnly: boolean;
  hasGoogle: boolean;
  hasApple: boolean;
}

async function renderProfile(
  c: import("hono").Context<{ Bindings: Env }>,
  user: ProfileUser,
): Promise<Response> {
  const reportedFlag = c.req.query("reported");
  const submittedFlag = c.req.query("submitted");
  const usernameFlag = c.req.query("username");
  const linkFlag = c.req.query("link");

  const [reportsRes, submissionsRes, ratingsCountRow, checkinsCountRow] = await Promise.all([
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
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?`)
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
  const checkinsCount = checkinsCountRow?.n ?? 0;
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
              {user.displayName ?? user.username ?? user.email}
            </h1>
            <p class="text-fg-muted">{user.email}</p>
            {user.username && <p class="mt-1 font-mono text-sm text-neon-cyan">@{user.username}</p>}
            <p class="mt-1 text-xs uppercase tracking-wider text-fg-dim">Rolle: {user.role}</p>
          </div>
        </div>
        <dl class="mt-6 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
          <Stat n={checkinsCount} label="Check-ins" />
          <Stat n={ratingsCount} label="Bewertungen" />
          <Stat n={reports.length} label="Korrekturen" />
          <Stat n={submissions.length} label="Vorschläge" />
        </dl>
        {(!user.hasGoogle || !user.hasApple) && (
          <div class="mt-6 border-2 border-border-hi bg-surface-2 p-4 space-y-3">
            <p class="text-sm text-fg-muted">
              Verknüpfe weitere Anmelde-Wege mit deinem Konto — du behältst dabei alle Bewertungen,
              Korrekturen und Check-ins.
            </p>
            <div class="flex flex-wrap gap-2">
              {!user.hasApple && (
                <a
                  href="/auth/apple"
                  class="inline-flex items-center gap-2 border-2 border-neon-cyan bg-transparent px-3 py-1.5 font-display tracking-wider uppercase text-neon-cyan transition-colors hover:bg-neon-cyan hover:text-bg"
                >
                  <span aria-hidden="true">▶</span>
                  Apple verbinden
                </a>
              )}
              {!user.hasGoogle && (
                <a
                  href="/auth/google"
                  class="inline-flex items-center gap-2 border-2 border-neon-cyan bg-transparent px-3 py-1.5 font-display tracking-wider uppercase text-neon-cyan transition-colors hover:bg-neon-cyan hover:text-bg"
                >
                  <span aria-hidden="true">▶</span>
                  Google verbinden
                </a>
              )}
            </div>
          </div>
        )}
        <form action="/auth/logout" method="post" class="mt-6" data-logout-form>
          <button
            type="submit"
            class="cursor-pointer border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wide text-fg-muted transition-colors hover:border-neon-pink hover:text-neon-pink"
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
      {linkFlag === "ok" && (
        <div class="mt-6 border-2 border-success/60 bg-success/10 p-4 text-success">
          ▶▶▶ Google-Konto verknüpft.
        </div>
      )}
      {linkFlag === "conflict" && (
        <div class="mt-6 border-2 border-danger/60 bg-danger/10 p-4 text-danger">
          ✗ Dieses Google-Konto ist bereits mit einem anderen Profil hier verbunden. Melde dich dort
          an oder schreib uns, wenn wir die Konten zusammenführen sollen.
        </div>
      )}

      {!user.username && (
        <section class="mt-6 border-2 border-border bg-surface p-6">
          <h2 class="font-display text-xl tracking-wide text-fg">Username wählen</h2>
          <p class="mt-2 text-fg-muted">
            Wähl dir einen Handle — 3–24 Zeichen, Kleinbuchstaben, Zahlen, Unterstrich. Einmal
            gewählt, nicht änderbar.
          </p>
          {usernameFlag === "invalid" && (
            <p class="mt-3 border-2 border-danger/60 bg-danger/10 p-3 text-danger">
              Nur Kleinbuchstaben, Zahlen, Unterstrich. 3–24 Zeichen.
            </p>
          )}
          {usernameFlag === "reserved" && (
            <p class="mt-3 border-2 border-danger/60 bg-danger/10 p-3 text-danger">
              Dieser Username ist reserviert. Wähl einen anderen.
            </p>
          )}
          {usernameFlag === "taken" && (
            <p class="mt-3 border-2 border-danger/60 bg-danger/10 p-3 text-danger">
              Schon vergeben. Wähl einen anderen.
            </p>
          )}
          <form
            action="/me/username"
            method="post"
            class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-stretch"
          >
            <label class="flex-1">
              <span class="sr-only">Username</span>
              <input
                type="text"
                name="username"
                required
                minLength={3}
                maxLength={24}
                pattern="[a-z0-9_]{3,24}"
                placeholder="z.B. jonas_s"
                class="w-full border-2 border-border-hi bg-surface-2 px-3 py-2.5 font-mono text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
              />
            </label>
            <button type="submit" class="btn-neon shrink-0">
              ▶ Username setzen
            </button>
          </form>
        </section>
      )}
      {user.username && usernameFlag === "ok" && (
        <div class="mt-6 border-2 border-success/60 bg-success/10 p-4 text-success">
          ▶▶▶ Username gesetzt: <span class="font-mono">@{user.username}</span>
        </div>
      )}
      {usernameFlag === "already_set" && (
        <div class="mt-6 border-2 border-danger/60 bg-danger/10 p-4 text-danger">
          Username ist schon gesetzt — Änderungen sind nicht möglich.
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
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="mt-12 border-2 border-danger/40 bg-surface p-6">
        <h2 class="font-display text-xl tracking-wide text-danger">Konto löschen</h2>
        <p class="mt-2 text-fg-muted">
          Löscht dein Konto unwiderruflich: E-Mail, Username, Profil, Sitzungen, Bewertungen,
          Check-ins und offene Vorschläge oder Korrekturen werden entfernt. Korrekturen und
          Vorschläge, die bereits in den{" "}
          <a
            class="text-neon-cyan underline-offset-2 hover:underline"
            href="https://github.com/boredland/trinkhallen-data"
          >
            offenen Datensatz
          </a>{" "}
          übernommen wurden, bleiben dort bestehen — der Verweis auf dein Konto wird anonymisiert.
        </p>
        {c.req.query("delete") === "unconfirmed" && (
          <p class="mt-3 border-2 border-danger/60 bg-danger/10 p-3 text-danger">
            Bitte das Häkchen setzen, um die Löschung zu bestätigen.
          </p>
        )}
        <details class="mt-4">
          <summary class="cursor-pointer text-sm uppercase tracking-wider text-fg-muted hover:text-danger">
            Konto wirklich löschen…
          </summary>
          <form action="/me/delete" method="post" class="mt-4 space-y-3" data-logout-form>
            <label class="flex items-start gap-2 text-sm text-fg-muted">
              <input
                type="checkbox"
                name="confirm"
                value="yes"
                required
                class="mt-1 accent-danger"
              />
              <span>
                Ich verstehe, dass diese Aktion endgültig ist und meine Daten nicht
                wiederhergestellt werden können.
              </span>
            </label>
            <button
              type="submit"
              class="cursor-pointer border-2 border-danger px-3 py-1.5 font-display text-sm tracking-wide text-danger transition-colors hover:bg-danger hover:text-bg"
            >
              Konto unwiderruflich löschen
            </button>
          </form>
        </details>
      </section>
    </Layout>,
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  // `text-status-open` is the theme-flippable amber (bright in dark mode,
  // a darker amber in light mode) — neon-amber alone washes out over the
  // warm-white surface-2 in light theme. Label moves up from fg-dim to
  // fg-muted for the same reason.
  return (
    <div class="border-2 border-border bg-surface-2 py-3">
      <div class="font-display text-3xl text-status-open tabular-nums">{n}</div>
      <div class="text-xs uppercase tracking-wider text-fg-muted">{label}</div>
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
    pr_opened: { de: "Akzeptiert", cls: "border-neon-cyan text-neon-cyan" },
    approved: { de: "Akzeptiert", cls: "border-neon-cyan text-neon-cyan" },
    merged: { de: "Übernommen", cls: "border-success text-success" },
    dismissed: { de: "Abgelehnt", cls: "border-border text-fg-dim" },
  };
  const cfg = map[status] ?? { de: status, cls: "border-border text-fg-dim" };
  return <span class={`border-2 px-2 py-0.5 ${cfg.cls}`}>{cfg.de}</span>;
}
