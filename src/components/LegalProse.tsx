import type { FC } from "hono/jsx";
import { type Lang, pathForLang } from "../lib/messages";

/**
 * English prose bodies for the otherwise-German static pages (/about,
 * /impressum, /datenschutz). The German versions live inline in routes/pages.tsx
 * and stay authoritative; these are courtesy translations rendered when the
 * request resolves to the `en` locale. Domain nouns (Trinkhalle/Späti/
 * Wasserhäuschen) are kept untranslated — they are the app's proper nouns.
 */

const A = "text-neon-cyan underline-offset-2 hover:underline";
const H2 = "font-display text-2xl tracking-wide text-fg";
const H2_SM = "font-display text-xl tracking-wide text-fg";

/** Banner shown atop the legally-relevant pages, pointing at the binding German
 *  original (the default locale, so a plain root-relative link). */
const CourtesyNote: FC<{ germanHref: string }> = ({ germanHref }) => (
  <p class="border-2 border-border bg-surface-2 p-3 text-sm text-fg-muted">
    This is a courtesy translation. The{" "}
    <a class={A} href={germanHref}>
      German version
    </a>{" "}
    is the legally binding one.
  </p>
);

const Metric: FC<{ value: number; label: string }> = ({ value, label }) => (
  <div class="border-2 border-border bg-surface p-4 sm:p-6">
    <div class="font-display text-3xl text-neon-pink sm:text-5xl">
      {value.toLocaleString("en-GB")}
    </div>
    <div class="mt-1 text-sm text-fg-muted">{label}</div>
  </div>
);

export const AboutBodyEn: FC<{
  lang: Lang;
  total: number;
  ratings: number;
  users: number;
}> = ({ lang, total, ratings, users }) => (
  <article class="space-y-10">
    <header>
      <h1 class="font-display text-4xl tracking-wide text-fg sm:text-6xl">
        trinkhallen<span class="text-neon-pink">.</span>app
      </h1>
      <p class="mt-3 text-lg text-fg-muted">
        {total.toLocaleString("en-GB")} Trinkhallen, Wasserhäuschen and Spätis on one map. Open,
        searchable, community-maintained — non-commercial.
      </p>
    </header>

    <section class="grid grid-cols-2 gap-4 sm:gap-6 md:grid-cols-3">
      <Metric value={total} label="Trinkhallen mapped" />
      <Metric value={ratings} label="Ratings submitted" />
      <Metric value={users} label="Registered people" />
    </section>

    <section>
      <h2 class={H2}>▶▶▶ What is this?</h2>
      <p class="mt-3 text-fg-muted">
        Looking for a Späti with card payment that's open right now, and want to navigate straight
        there? That's exactly what trinkhallen.app is built for.
      </p>
      <p class="mt-3 text-fg-muted">
        trinkhallen.app is the open successor to{" "}
        <a class={A} href="https://app.hopfenstop.de/">
          HopfenStop
        </a>
        . HopfenStop's carefully curated Frankfurt dataset forms the basis and lives on here —
        supplemented with OpenStreetMap data for the whole of Germany, a transparent contribution
        pipeline on GitHub, and maintenance by the community rather than a single person.
      </p>
    </section>

    <section>
      <h2 class={H2}>▶▶▶ Data</h2>
      <p class="mt-3 text-fg-muted">
        All kiosk metadata is openly available on GitHub as GeoJSON, with per-entry source
        attribution (<code class="font-mono">sources[]</code>):
      </p>
      <ul class="mt-3 space-y-2 text-fg-muted">
        <li>
          <a class={A} href="https://github.com/boredland/trinkhallen-data">
            boredland/trinkhallen-data
          </a>{" "}
          — the dataset. PRs welcome.
        </li>
        <li>
          <a class={A} href="https://github.com/boredland/trinkhallen-app">
            boredland/trinkhallen-app
          </a>{" "}
          — the code (Cloudflare Workers + Hono).
        </li>
      </ul>
      <p class="mt-3 text-sm text-fg-dim">
        <strong>Sources:</strong> HopfenStop (Frankfurt seed,{" "}
        <a class={A} href="https://creativecommons.org/licenses/by-nc/4.0/">
          CC BY-NC 4.0
        </a>
        ) · OpenStreetMap (
        <a class={A} href="https://www.openstreetmap.org/copyright">
          ODbL
        </a>
        ) · contributions from users.
      </p>
    </section>

    <section>
      <h2 class={H2}>▶▶▶ Get involved</h2>
      <ul class="mt-3 space-y-3 text-fg-muted">
        <li>
          <span class="font-display text-fg">Rate:</span> 1–5 stars + an optional comment on every
          detail page (login required).
        </li>
        <li>
          <span class="font-display text-fg">Were you here?</span> Check in with a single tap on the
          detail page — if data is missing (opening hours, payment, seating, toilet, …) the form
          asks a quick question. Answers go through moderation and land in the open dataset.
        </li>
        <li>
          <span class="font-display text-fg">Correct:</span> the “Data wrong?” section covers
          closed, duplicate entry, wrong address and so on. Moderation reviews it and folds the
          correction into the dataset.
        </li>
        <li>
          <span class="font-display text-fg">Suggest:</span>{" "}
          <a class={A} href={pathForLang("/add", lang)}>
            /add
          </a>{" "}
          → click a Späti on the map, enter address + opening hours + payment.
        </li>
        <li>
          <span class="font-display text-fg">PR directly on GitHub:</span> if you prefer, fork the
          dataset and open PRs against{" "}
          <a class={A} href="https://github.com/boredland/trinkhallen-data">
            trinkhallen-data
          </a>{" "}
          — the dataset is primary, the app is just the UI on top.
        </li>
      </ul>
    </section>

    <section>
      <h2 class={H2}>▶▶▶ Stack</h2>
      <ul class="mt-3 space-y-1.5 text-sm text-fg-muted">
        <li>Cloudflare Workers · Hono SSR · TypeScript · D1 (SQLite)</li>
        <li>MapLibre GL JS · OpenFreeMap (vector tiles, no API key)</li>
        <li>Tailwind CSS v4 · Anton / Inter · no trackers, no analytics</li>
        <li>
          Auth: magic link by email (Cloudflare Email Routing) or Google SSO — with automatic merge
          of the two when the address matches.
        </li>
        <li>
          Weekly OSM ingest + data enrichment (opening hours, payment, place IDs) via a GitHub
          Actions pipeline.
        </li>
      </ul>
    </section>

    <section>
      <h2 class={H2}>▶▶▶ Licence</h2>
      <p class="mt-3 text-sm text-fg-muted">
        <strong class="text-fg">Data:</strong> CC BY-NC 4.0 — free to share and adapt, with
        attribution, non-commercial.
        <br />
        <strong class="text-fg">Code:</strong> AGPL-3.0-or-later.
      </p>
    </section>

    <section>
      <h2 class={H2}>▶▶▶ Operator</h2>
      <p class="mt-3 text-fg-muted">
        trinkhallen.app is run by{" "}
        <a class={A} href="https://github.com/boredland">
          Jonas (boredland)
        </a>{" "}
        as a non-commercial open-source project. Contact &amp; issues via{" "}
        <a class={A} href="https://github.com/boredland/trinkhallen-app/issues">
          GitHub
        </a>
        .
      </p>
    </section>

    <footer class="pt-4 text-xs text-fg-dim">
      Bugs &amp; wishes →{" "}
      <a class={A} href="https://github.com/boredland/trinkhallen-app/issues">
        GitHub Issues
      </a>
      .
    </footer>
  </article>
);

export const ImpressumBodyEn: FC = () => (
  <article class="space-y-8">
    <header>
      <h1 class="font-display text-4xl tracking-wide text-fg sm:text-5xl">Legal notice</h1>
      <p class="mt-3 text-fg-muted">Information pursuant to § 5 TMG</p>
    </header>

    <CourtesyNote germanHref="/impressum" />

    <section>
      <h2 class={H2_SM}>Operator</h2>
      <address class="mt-3 not-italic text-fg-muted">
        Jonas Strassel
        <br />
        Am Kappelgarten 24
        <br />
        60389 Frankfurt am Main
        <br />
        Germany
      </address>
    </section>

    <section>
      <h2 class={H2_SM}>Contact</h2>
      <p class="mt-3 text-fg-muted">
        Email:{" "}
        <a class={A} href="mailto:feedback@trinkhallen.app">
          feedback@trinkhallen.app
        </a>
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Responsible for the content</h2>
      <p class="mt-3 text-fg-muted">
        Jonas Strassel (address as above). trinkhallen.app is a non-commercial open-source project;
        the dataset lives in a public{" "}
        <a class={A} href="https://github.com/boredland/trinkhallen-data">
          GitHub repository
        </a>{" "}
        and is maintained by the community.
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Liability for content</h2>
      <p class="mt-3 text-fg-muted">
        The contents of this site were created with the greatest possible care. However, no
        guarantee can be given for the accuracy, completeness and timeliness of the kiosk data
        (opening hours, payment methods, location, etc.) — it comes from open sources
        (OpenStreetMap, community contributions) and may be out of date.
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Liability for links</h2>
      <p class="mt-3 text-fg-muted">
        This site contains links to external third-party websites over whose content we have no
        influence. The respective provider is always responsible for that third-party content. If we
        become aware of any legal infringements, the relevant links will be removed promptly.
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Copyright</h2>
      <p class="mt-3 text-fg-muted">
        The source code of this application is licensed under{" "}
        <a class={A} href="https://www.gnu.org/licenses/agpl-3.0.html">
          AGPL-3.0-or-later
        </a>
        , the dataset under{" "}
        <a class={A} href="https://creativecommons.org/licenses/by-nc/4.0/">
          CC BY-NC 4.0
        </a>
        . Map data © OpenStreetMap contributors (
        <a class={A} href="https://www.openstreetmap.org/copyright">
          ODbL
        </a>
        ).
      </p>
    </section>
  </article>
);

export const DatenschutzBodyEn: FC = () => (
  <article class="space-y-8">
    <header>
      <h1 class="font-display text-4xl tracking-wide text-fg sm:text-5xl">Privacy policy</h1>
      <p class="mt-3 text-fg-muted">
        We store as little as possible. No trackers, no analytics, no advertising. What we process
        and why is set out in full here.
      </p>
    </header>

    <CourtesyNote germanHref="/datenschutz" />

    <section>
      <h2 class={H2_SM}>Controller</h2>
      <address class="mt-3 not-italic text-fg-muted">
        Jonas Strassel
        <br />
        Am Kappelgarten 24
        <br />
        60389 Frankfurt am Main
        <br />
        Email:{" "}
        <a class={A} href="mailto:feedback@trinkhallen.app">
          feedback@trinkhallen.app
        </a>
      </address>
    </section>

    <section>
      <h2 class={H2_SM}>Anonymous use of the map</h2>
      <p class="mt-3 text-fg-muted">
        You can use the map completely anonymously — no account, no login. When the page is loaded,
        technically unavoidable data (IP address, user agent, requested URL) is logged in the server
        logs of our host, Cloudflare. Legal basis: Art. 6(1)(f) GDPR (legitimate interest in the
        operation and security of the site). Storage period: a maximum of 30 days.
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Login by email (magic link)</h2>
      <p class="mt-3 text-fg-muted">
        When you log in by magic link, we store your email address, a hashed version of the one-time
        token, and your IP address and user agent (for abuse protection). The token becomes invalid
        once redeemed, or after 15 minutes at the latest. Legal basis: Art. 6(1)(b) GDPR
        (performance of the usage relationship).
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Login via Google</h2>
      <p class="mt-3 text-fg-muted">
        If you log in via Google, we store only your email address and a stable internal ID from
        your Google profile. We store neither your name nor your profile picture — should Google
        transmit them, we discard them. When you are redirected to Google, your browser shares your
        IP address with Google. We process the data solely to recognise you and attribute your
        content (ratings, corrections, check-ins) to you. Legal basis: Art. 6(1)(b) GDPR; data is
        only transmitted to Google if you actively start the login.
      </p>
      <p class="mt-3 text-fg-muted">
        Provider: Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Ireland. Privacy:{" "}
        <a class={A} href="https://policies.google.com/privacy">
          policies.google.com/privacy
        </a>
        .
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Login via Apple</h2>
      <p class="mt-3 text-fg-muted">
        If you log in via “Sign in with Apple”, we receive your email address and a stable internal
        ID from Apple. If you choose Apple's “Hide My Email”, that is an anonymous relay address —
        we can only reach you by email through it, without knowing your real address. We don't ask
        for a name, and Apple doesn't provide a profile picture. We process the data solely to
        recognise you and attribute your content to you. Legal basis: Art. 6(1)(b) GDPR; data is
        only transmitted to Apple if you actively start the login.
      </p>
      <p class="mt-3 text-fg-muted">
        Provider: Apple Distribution International Ltd., Hollyhill Industrial Estate, Hollyhill,
        Cork, Ireland. Privacy:{" "}
        <a class={A} href="https://www.apple.com/legal/privacy/">
          apple.com/legal/privacy
        </a>
        .
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Session cookie</h2>
      <p class="mt-3 text-fg-muted">
        When you're logged in, we set a single session cookie (
        <code class="font-mono">__Host-tk_sess</code>) containing a random, cryptographically signed
        ID. It is <code class="font-mono">HttpOnly</code>, <code class="font-mono">Secure</code> and
        expires after 30 days of inactivity. We use no tracking or marketing cookies. Legal basis:
        Art. 6(1)(b) GDPR (technically necessary for operation).
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Your own contributions</h2>
      <p class="mt-3 text-fg-muted">
        Ratings, data corrections, Späti suggestions and check-ins are stored linked to your user
        account. Approved corrections and suggestions are additionally folded into the public,
        openly licensed dataset{" "}
        <a class={A} href="https://github.com/boredland/trinkhallen-data">
          trinkhallen-data
        </a>{" "}
        and become a permanent part of the open history there. A random UUID with no personal
        reference for outsiders is stored with the entry. The only thing publicly visible next to
        your ratings is your automatically generated, pseudonymous handle (e.g. @pfand_pirat) —
        never your name. Legal basis: Art. 6(1)(b) GDPR.
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Third parties &amp; data transfers</h2>
      <ul class="mt-3 space-y-3 text-fg-muted">
        <li>
          <strong class="text-fg">Cloudflare</strong> (Workers, D1 database, edge cache): hosting of
          the application. Location: worldwide. A data processing agreement (DPA) and standard
          contractual clauses are in place.
        </li>
        <li>
          <strong class="text-fg">Google</strong>: only if you use the Google login (see above).
        </li>
        <li>
          <strong class="text-fg">OpenFreeMap</strong>: provides the map tiles. When the map is
          displayed, your browser shares your IP address with OpenFreeMap to deliver the tiles.
          Provider:{" "}
          <a class={A} href="https://openfreemap.org/">
            openfreemap.org
          </a>
          .
        </li>
        <li>
          <strong class="text-fg">Photon (Komoot)</strong>: pre-fills the address on{" "}
          <code>/add</code> from your chosen map position. Your browser sends the coordinates to
          Photon (based on OpenStreetMap data); the IP address is technically unavoidable. Provider:
          Komoot GmbH;{" "}
          <a class={A} href="https://photon.komoot.io/">
            photon.komoot.io
          </a>
          .
        </li>
      </ul>
    </section>

    <section>
      <h2 class={H2_SM}>Storage period</h2>
      <p class="mt-3 text-fg-muted">
        Account and contribution data remain stored as long as your account exists. Delete your
        account by sending a short email to the address above — we delete it within 14 days. Server
        logs are automatically discarded after a maximum of 30 days. Magic-link tokens are invalid
        once redeemed or after 15 minutes.
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Your rights</h2>
      <p class="mt-3 text-fg-muted">
        You have the right at any time to access (Art. 15 GDPR), rectification (Art. 16), erasure
        (Art. 17), restriction of processing (Art. 18), data portability (Art. 20) and objection
        (Art. 21). A short email to{" "}
        <a class={A} href="mailto:feedback@trinkhallen.app">
          feedback@trinkhallen.app
        </a>{" "}
        is enough.
      </p>
      <p class="mt-3 text-fg-muted">
        You also have the right to lodge a complaint with a data protection supervisory authority —
        the one responsible for us:{" "}
        <a class={A} href="https://datenschutz.hessen.de/">
          The Hessian Commissioner for Data Protection and Freedom of Information
        </a>
        .
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Android app (Trusted Web Activity)</h2>
      <p class="mt-3 text-fg-muted">
        The Android app on the Google Play Store (<code class="font-mono">app.trinkhallen.twa</code>
        ) is a <em>Trusted Web Activity</em> — technically, it loads only this website in a
        full-screen Chrome browser container. There is no separate app data path, no additional
        trackers, and no processing beyond the data flows described above. All the rules stated here
        on logging, login, cookies and contributions apply identically to the app.
      </p>
      <p class="mt-3 text-fg-muted">
        Independently of this, Google Play collects technical telemetry when the app is installed,
        updated or uninstalled (device and Android version, country, optional crash reports). We
        have no direct access to this data; it is subject to the{" "}
        <a class={A} href="https://policies.google.com/privacy">
          Google privacy policy
        </a>
        . Push notifications are currently not enabled.
      </p>
    </section>

    <section>
      <h2 class={H2_SM}>Changes</h2>
      <p class="mt-3 text-fg-muted">
        This statement may change as we develop the service further. The current version is always
        shown here. We will announce material changes before they take effect.
      </p>
    </section>
  </article>
);
