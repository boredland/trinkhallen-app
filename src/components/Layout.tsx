import type { FC, PropsWithChildren } from "hono/jsx";
import { asset, type ClientEntry } from "../lib/assets";

export interface LayoutProps {
  title?: string;
  description?: string;
  /** Page identifier used to highlight the active nav link. */
  nav?: "map" | "list" | "about" | "me";
  /** Pre-bundled client entry points to load on this page. */
  clientEntries?: ClientEntry[];
  /** Set to true on the map page so the body becomes full-bleed. */
  fullBleed?: boolean;
}

const SITE = "TRINKHALLEN.APP";
const DESCRIPTION_DEFAULT =
  "Finde Trinkhallen, Wasserhäuschen und Spätis in deiner Nähe. Offen jetzt, Karte akzeptiert, ein Klick zur Navigation.";

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  children,
  title,
  description = DESCRIPTION_DEFAULT,
  nav = "map",
  clientEntries = ["app"],
  fullBleed = false,
}) => {
  const fullTitle = title ? `${title} · ${SITE}` : SITE;

  return (
    <html lang="de" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0A0A0A" />
        <meta name="description" content={description} />
        <meta property="og:title" content={fullTitle} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <title>{fullTitle}</title>

        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&display=swap"
        />

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
      </head>
      <body class={fullBleed ? "h-dvh overflow-hidden" : "min-h-dvh"}>
        <Header nav={nav} />
        <main class={fullBleed ? "absolute inset-0 top-[var(--header-h)]" : "mx-auto w-full max-w-5xl px-4 py-8"}>
          {children}
        </main>
        {!fullBleed && <Footer />}
      </body>
    </html>
  );
};

const Header: FC<{ nav: NonNullable<LayoutProps["nav"]> }> = ({ nav }) => (
  <header class="sticky top-0 z-40 h-[var(--header-h)] border-b-2 border-border bg-bg/95 backdrop-blur">
    <div class="mx-auto flex h-full w-full max-w-7xl items-center gap-6 px-4">
      <a href="/" class="font-display text-xl tracking-wide text-fg">
        TRINKHALLEN<span class="text-neon-pink">.</span>APP
      </a>
      <nav class="hidden flex-1 items-center gap-4 sm:flex">
        <NavLink href="/" active={nav === "map"} label="Karte" />
        <NavLink href="/list" active={nav === "list"} label="Liste" />
        <NavLink href="/about" active={nav === "about"} label="Über" />
      </nav>
      <div class="flex flex-1 items-center justify-end gap-3 sm:flex-none">
        <button
          type="button"
          aria-label="Theme wechseln"
          class="text-fg-muted transition-colors hover:text-fg-neon-amber"
          data-theme-toggle
        >
          ☾
        </button>
        <a
          href="/me"
          class="border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wide text-fg transition-colors hover:border-neon-pink hover:text-neon-pink"
        >
          {nav === "me" ? "Profil" : "Login"}
        </a>
      </div>
    </div>
  </header>
);

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
    <div class="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-6 text-sm text-fg-dim sm:flex-row sm:justify-between">
      <p>
        Daten: CC BY-NC 4.0 ·{" "}
        <a class="underline-offset-2 hover:text-neon-cyan hover:underline" href="/about">
          Über &amp; Mitwirken
        </a>
      </p>
      <p>
        Inspiriert von{" "}
        <a class="underline-offset-2 hover:text-neon-cyan hover:underline" href="https://app.hopfenstop.de/">
          HopfenStop
        </a>
        · OSM &amp; Mitwirkende
      </p>
    </div>
  </footer>
);
