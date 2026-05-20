import type { FC, PropsWithChildren } from "hono/jsx";
import { asset, type ClientEntry } from "../lib/assets";

export interface LayoutUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: "user" | "moderator" | "admin";
}

export interface LayoutProps {
  title?: string;
  description?: string;
  /** Page identifier used to highlight the active nav link. */
  nav?: "map" | "list" | "about" | "me" | "moderate";
  /** Pre-bundled client entry points to load on this page. */
  clientEntries?: ClientEntry[];
  /** Set to true on the map page so the body becomes full-bleed. */
  fullBleed?: boolean;
  /** Pass `c.var.user` through; controls the header right-hand area. */
  user?: LayoutUser | undefined;
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
  user,
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

        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.svg" />
        <link rel="manifest" href="/manifest.webmanifest" />

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
        <Header nav={nav} user={user} />
        <main class={fullBleed ? "absolute inset-0 top-[var(--header-h)]" : "mx-auto w-full max-w-5xl px-4 py-8"}>
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
        <NavLink href="/list" active={nav === "list"} label="Liste" />
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
          <a
            href="/me"
            class="flex items-center gap-2 border-2 border-border-hi px-2 py-1 font-display text-sm tracking-wide text-fg transition-colors hover:border-neon-pink hover:text-neon-pink"
          >
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                width="24"
                height="24"
                class="rounded-full"
                referrerpolicy="no-referrer"
              />
            ) : (
              <span class="grid h-6 w-6 place-items-center bg-neon-pink/20 text-xs text-neon-pink">
                {initials(user)}
              </span>
            )}
            <span class="hidden sm:inline">{shortName(user)}</span>
          </a>
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

function shortName(user: LayoutUser): string {
  if (user.displayName) return user.displayName.split(" ")[0]!;
  return user.email.split("@")[0]!;
}
function initials(user: LayoutUser): string {
  const name = user.displayName ?? user.email;
  const parts = name.split(/\s+|@/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

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
