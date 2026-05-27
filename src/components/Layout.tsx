import { raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";
import { asset, type ClientEntry } from "../lib/assets";

export interface LayoutUser {
  id: string;
  email: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: "user" | "moderator" | "admin";
}

export interface LayoutProps {
  title?: string;
  description?: string;
  /** Absolute URL of the canonical version of this page. Routed in from
   *  src/routes/pages.tsx so query-string variants don't fragment indexing. */
  canonicalUrl?: string;
  /** Set on auth-gated / functional pages to keep them out of the index. */
  noindex?: boolean;
  /** Pre-serialised JSON-LD blocks; each becomes its own `<script>` in <head>.
   *  Pass a single object or an array — we wrap and stringify here. */
  jsonLd?: object | object[];
  /** Page identifier used to highlight the active nav link. */
  nav?: "map" | "about" | "me" | "moderate";
  /** Pre-bundled client entry points to load on this page. */
  clientEntries?: ClientEntry[];
  /** Set to true on the map page so the body becomes full-bleed. */
  fullBleed?: boolean;
  /** Pass `c.var.user` through; controls the header right-hand area. */
  user?: LayoutUser | undefined;
}

const SITE = "TRINKHALLEN.APP";
const ORIGIN = "https://trinkhallen.app";
const DESCRIPTION_DEFAULT =
  "Finde Trinkhallen, Wasserhäuschen und Spätis in deiner Nähe. Offen jetzt, Karte akzeptiert, ein Klick zur Navigation.";

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  children,
  title,
  description = DESCRIPTION_DEFAULT,
  canonicalUrl,
  noindex = false,
  jsonLd,
  nav = "map",
  clientEntries = ["app"],
  fullBleed = false,
  user,
}) => {
  const fullTitle = title ? `${title} · ${SITE}` : SITE;
  const canonical = canonicalUrl ?? ORIGIN + (nav === "about" ? "/about" : "/");
  // 1200×630 PNG — Slack/Discord/Twitter/LinkedIn all want this aspect
  // ratio for a proper preview card. Generated from the brand wordmark
  // via scripts/og-render.ts → public/og-1200x630.png.
  const ogImage = `${ORIGIN}/og-1200x630.png`;
  const isMapPage = clientEntries.includes("map") || clientEntries.includes("pick");
  const jsonLdBlocks = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [];

  return (
    <html lang="de" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0A0A0A" />
        {/* Declared in the HTML (before any CSS) so the browser paints a dark
            canvas during the cross-page navigation gap — without it the UA
            falls back to a white backdrop and dark-mode users see a brief
            light flash between pages. The CSS still flips this to `light` for
            [data-theme="light"] once it loads. */}
        <meta name="color-scheme" content="dark" />
        <meta name="description" content={description} />
        {noindex && <meta name="robots" content="noindex, nofollow" />}
        <link rel="canonical" href={canonical} />
        <meta property="og:title" content={fullTitle} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta
          property="og:image:alt"
          content="trinkhallen.app — Karte deutscher Trinkhallen, Wasserhäuschen und Spätis"
        />
        <meta property="og:locale" content="de_DE" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={fullTitle} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={ogImage} />
        <link rel="alternate" hreflang="de" href={canonical} />
        <title>{fullTitle}</title>

        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.svg" />
        <link rel="manifest" href="/manifest.webmanifest" />

        {/* iOS only honours these — without them, "Add to Home Screen" still
            shows Safari chrome. The translucent status bar matches the
            #0A0A0A theme-color above. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="trinkhallen" />

        {isMapPage && (
          <>
            <link rel="preconnect" href="https://tiles.openfreemap.org" crossorigin="" />
            {/* Style JSON is the first request MapLibre makes; preload it so
                the browser's lookahead scanner fires before our JS executes
                and parses the URL out of build-style.ts. */}
            <link
              rel="preload"
              href="https://tiles.openfreemap.org/styles/dark"
              as="fetch"
              crossorigin=""
            />
          </>
        )}
        {/* Fonts (Anton + Inter) are self-hosted via @fontsource and bundled
            into the client CSS chunk by Vite — see src/client/app.entry.ts.
            No render-blocking cross-origin stylesheet load. */}

        {(() => {
          const assets = clientEntries.map(asset);
          const cssHrefs = new Set<string>();
          for (const a of assets) for (const href of a.css) cssHrefs.add(href);
          return (
            <>
              {[...cssHrefs].map((href) => (
                <link rel="stylesheet" href={href} />
              ))}
              {assets.map((a) => (
                <script type="module" src={a.js} />
              ))}
            </>
          );
        })()}

        {jsonLdBlocks.map((block) => (
          <script type="application/ld+json">
            {raw(JSON.stringify(block).replace(/</g, "\\u003c"))}
          </script>
        ))}

        {/* Speculation Rules — Chromium browsers prerender same-origin
            /k/* and /stadt/* targets on user intent (hover / pointerdown
            via `eagerness: moderate`). Cap is enforced by the browser
            (~10 concurrent prerenders). Falls back silently elsewhere.
            ?partial=1 links never appear as <a href> so don't need an
            exclusion — they only fire from HTMX fetches. */}
        <script type="speculationrules">
          {raw(
            JSON.stringify({
              prerender: [
                {
                  where: {
                    or: [{ href_matches: "/k/*" }, { href_matches: "/stadt/*" }],
                  },
                  eagerness: "moderate",
                },
              ],
            }),
          )}
        </script>
      </head>
      <body class={fullBleed ? "h-dvh overflow-hidden" : "min-h-dvh"}>
        <Header nav={nav} user={user} />
        <main
          class={
            fullBleed
              ? "absolute inset-0 top-[var(--header-h)]"
              : "mx-auto w-full max-w-5xl px-4 py-8"
          }
        >
          {children}
        </main>
        {!fullBleed && <Footer />}
      </body>
    </html>
  );
};

const Header: FC<{ nav: NonNullable<LayoutProps["nav"]>; user?: LayoutUser | undefined }> = ({
  nav,
  user,
}) => (
  <header class="sticky top-0 z-40 h-[var(--header-h)] border-b-2 border-border bg-bg/95 backdrop-blur">
    <div class="mx-auto flex h-full w-full max-w-7xl items-center gap-6 px-4">
      <a href="/" class="font-display text-xl tracking-wide text-fg">
        TRINKHALLEN<span class="text-neon-pink">.</span>APP
      </a>
      <nav class="hidden flex-1 items-center gap-4 sm:flex">
        <NavLink href="/" active={nav === "map"} label="Karte" />
        <NavLink href="/about" active={nav === "about"} label="Über" />
        {user && (user.role === "moderator" || user.role === "admin") && (
          <NavLink href="/moderate" active={nav === "moderate"} label="Mod" />
        )}
      </nav>
      <div class="flex flex-1 items-center justify-end gap-3 sm:flex-none">
        <button
          type="button"
          aria-label="Theme wechseln"
          class="cursor-pointer text-fg-muted transition-colors hover:text-neon-pink"
          data-theme-toggle
        >
          {/* Glyph reflects the mode you'd switch TO; flipped on click. SSR
              starts with the moon (dark→click→light); app.entry.ts swaps to
              the sun once it sees [data-theme="dark"] on the html element. */}
          <span data-theme-icon>☾</span>
        </button>
        {user ? (
          <UserButton user={user} />
        ) : (
          <a
            href="/me"
            class="border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wide text-fg transition-colors hover:border-neon-pink hover:text-neon-pink"
          >
            Login
          </a>
        )}
      </div>
    </div>
  </header>
);

type HeaderIdentity =
  | { kind: "handle"; username: string; avatarUrl: string | null }
  | { kind: "named"; firstName: string; avatarUrl: string | null }
  | { kind: "anonymous" };

/**
 * Pick the strongest identity signal the user actually owns. The email
 * local-part is intentionally absent — it's a system address half, not a
 * name. A user-set `username` outranks the auto-populated `display_name`
 * because the user deliberately chose it.
 */
function identifyForHeader(user: LayoutUser): HeaderIdentity {
  if (user.username) {
    return { kind: "handle", username: user.username, avatarUrl: user.avatarUrl };
  }
  if (user.displayName) {
    return {
      kind: "named",
      firstName: user.displayName.split(/\s+/)[0] ?? user.displayName,
      avatarUrl: user.avatarUrl,
    };
  }
  return { kind: "anonymous" };
}

const UserButton: FC<{ user: LayoutUser }> = ({ user }) => {
  const id = identifyForHeader(user);

  if (id.kind === "handle") {
    return (
      <a
        href="/me"
        class="group inline-flex items-center gap-2 border-2 border-border-hi px-2 py-1 transition-colors hover:border-neon-pink"
        aria-label={`Profil von @${id.username}`}
      >
        {id.avatarUrl ? (
          <img
            src={id.avatarUrl}
            alt=""
            width="24"
            height="24"
            class="h-6 w-6 object-cover"
            referrerpolicy="no-referrer"
          />
        ) : (
          <span class="grid h-6 w-6 place-items-center bg-neon-pink/15 font-display text-xs text-neon-pink">
            {id.username[0]!.toUpperCase()}
          </span>
        )}
        <span class="hidden font-mono text-sm lowercase text-neon-cyan transition-colors group-hover:text-neon-pink sm:inline">
          @{id.username}
        </span>
      </a>
    );
  }

  if (id.kind === "named") {
    return (
      <a
        href="/me"
        class="group inline-flex items-center gap-2 border-2 border-border-hi px-2 py-1 transition-colors hover:border-neon-pink"
        aria-label={`Profil von ${id.firstName}`}
      >
        {id.avatarUrl ? (
          <img
            src={id.avatarUrl}
            alt=""
            width="24"
            height="24"
            class="h-6 w-6 object-cover"
            referrerpolicy="no-referrer"
          />
        ) : (
          <span class="grid h-6 w-6 place-items-center bg-neon-pink/15 font-display text-xs text-neon-pink">
            {id.firstName[0]!.toUpperCase()}
          </span>
        )}
        <span class="hidden font-display text-sm tracking-wide uppercase text-fg transition-colors group-hover:text-neon-pink sm:inline">
          {id.firstName}
        </span>
      </a>
    );
  }

  // Anonymous: magic-link signup who hasn't picked a username yet. Sober
  // "Profil" label, neutral glyph badge, single amber square in the corner
  // as the only contrast — a quiet "incomplete" cue, not a notification dot.
  return (
    <a
      href="/me"
      class="group relative inline-flex items-center gap-2 border-2 border-border-hi px-2 py-1 transition-colors hover:border-neon-pink"
      title="Username noch nicht gewählt"
      aria-label="Profil — Username noch nicht gewählt"
    >
      <span class="relative grid h-6 w-6 place-items-center border border-border bg-bg font-display text-xs text-fg-muted transition-colors group-hover:border-neon-pink group-hover:text-neon-pink">
        <span aria-hidden="true">◉</span>
        <span class="-top-px -right-px absolute h-1.5 w-1.5 bg-neon-amber" aria-hidden="true" />
      </span>
      <span class="hidden font-display text-sm tracking-wide uppercase text-fg-muted transition-colors group-hover:text-neon-pink sm:inline">
        Profil
      </span>
    </a>
  );
};

const NavLink: FC<{ href: string; active: boolean; label: string }> = ({ href, active, label }) => (
  <a
    href={href}
    class={`font-display text-sm tracking-wider uppercase transition-colors ${
      active ? "text-neon-pink" : "text-fg-muted hover:text-fg"
    }`}
  >
    {label}
  </a>
);

const Footer: FC = () => (
  <footer class="mt-16 border-t-2 border-border">
    <div class="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-6 text-sm text-fg-dim sm:flex-row sm:items-center sm:justify-between">
      <p>
        Daten: CC BY-NC 4.0 ·{" "}
        <a class="underline-offset-2 hover:text-neon-cyan hover:underline" href="/about">
          Über &amp; Mitwirken
        </a>
      </p>
      <nav class="flex flex-wrap gap-x-4 gap-y-1">
        <a class="underline-offset-2 hover:text-neon-cyan hover:underline" href="/impressum">
          Impressum
        </a>
        <a class="underline-offset-2 hover:text-neon-cyan hover:underline" href="/datenschutz">
          Datenschutz
        </a>
        <a
          class="underline-offset-2 hover:text-neon-cyan hover:underline"
          href="https://app.hopfenstop.de/"
        >
          HopfenStop
        </a>
      </nav>
    </div>
  </footer>
);
