import type { FC } from "hono/jsx";
import type { KioskRecord } from "../lib/db";
import { buildNavigateTargets } from "../lib/navigate";
import { computeStatus, formatStatus } from "../lib/opening-hours";
import type { Aggregate, RatingRow } from "../lib/ratings";
import { tagLabel } from "../lib/tags";
import { RatingBlock } from "./RatingBlock";
import { ReportForm } from "./ReportForm";

type TriState = "yes" | "no" | "unknown";

const PAYMENT_LABELS: Record<string, { de: string; icon: string }> = {
  cash: { de: "Bar", icon: "💶" },
  cards: { de: "Karte", icon: "💳" },
  contactless: { de: "Kontaktlos", icon: "📲" },
  girocard: { de: "Girocard", icon: "🟦" },
  mobile: { de: "Apple/Google Pay", icon: "📱" },
};
const PAYMENT_ORDER = ["cash", "cards", "contactless", "girocard", "mobile"] as const;

export const KioskDetail: FC<{
  kiosk: KioskRecord;
  userAgent: string | null;
  aggregate: Aggregate;
  ownRating: RatingRow | null;
  isLoggedIn: boolean;
}> = ({ kiosk, userAgent, aggregate, ownRating, isLoggedIn }) => {
  const status = computeStatus(kiosk.hours?.raw);
  const statusLabel = formatStatus(status);
  const nav = buildNavigateTargets({
    name: kiosk.name,
    lat: kiosk.lat,
    lng: kiosk.lng,
    userAgent,
  });

  const addr = kiosk.address;
  const addrLine1 = [addr["street"], addr["number"]].filter(Boolean).join(" ");
  const addrLine2 = [addr["postalcode"], addr["city"]].filter(Boolean).join(" ");
  const district = addr["district"];

  const hopfenstopSource = kiosk.sources?.find((s) => s.type === "hopfenstop");

  return (
    <article class="border-2 border-border bg-surface">
      <header class="border-b-2 border-border p-6">
        <p
          class={`mb-3 font-display text-sm tracking-wider uppercase ${
            status.kind === "open"
              ? "text-neon-amber"
              : status.kind === "closed"
                ? "text-fg-dim"
                : "text-fg-muted"
          }`}
        >
          {status.kind === "open" ? "▶▶▶ " : status.kind === "closed" ? "■ " : "… "}
          {statusLabel}
        </p>
        <h1 class="font-display text-3xl tracking-wide text-fg sm:text-5xl">{kiosk.name}</h1>
        <p class="mt-3 text-fg-muted">
          {addrLine1}
          {addrLine2 && <span class="text-fg-dim"> · {addrLine2}</span>}
          {district && <span class="text-fg-dim"> · {district}</span>}
        </p>
      </header>

      <section class="border-b-2 border-border p-6">
        <a
          href={nav.primary.href}
          class="btn-neon w-full sm:w-auto"
          data-navigate-primary
        >
          ▶ Hin navigieren
        </a>
        <details class="mt-3 text-sm text-fg-muted">
          <summary class="cursor-pointer hover:text-fg">Anderes Maps-Programm öffnen</summary>
          <ul class="mt-2 space-y-1 pl-4">
            <li>
              <a class="text-neon-cyan underline-offset-2 hover:underline" href={nav.apple.href}>
                {nav.apple.label}
              </a>
            </li>
            <li>
              <a class="text-neon-cyan underline-offset-2 hover:underline" href={nav.geo.href}>
                {nav.geo.label}
              </a>
            </li>
            <li>
              <a
                class="text-neon-cyan underline-offset-2 hover:underline"
                href={nav.google.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {nav.google.label}
              </a>
            </li>
          </ul>
        </details>
      </section>

      {kiosk.payment && (
        <section class="border-b-2 border-border p-6">
          <h2 class="mb-3 font-display text-sm tracking-wider uppercase text-fg-muted">
            Zahlung
          </h2>
          <ul class="flex flex-wrap gap-2">
            {PAYMENT_ORDER.map((key) => {
              const value = kiosk.payment?.[key] as TriState | undefined;
              if (!value) return null;
              const meta = PAYMENT_LABELS[key];
              if (!meta) return null;
              return (
                <li>
                  <PaymentBadge label={meta.de} icon={meta.icon} state={value} />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {kiosk.hours?.raw && (
        <section class="border-b-2 border-border p-6">
          <h2 class="mb-2 font-display text-sm tracking-wider uppercase text-fg-muted">
            Öffnungszeiten
          </h2>
          <p class="font-mono text-fg">{kiosk.hours.raw}</p>
        </section>
      )}

      {kiosk.description && (
        <section class="border-b-2 border-border p-6">
          <h2 class="mb-2 font-display text-sm tracking-wider uppercase text-fg-muted">
            Beschreibung
          </h2>
          <p class="text-fg whitespace-pre-line">{kiosk.description}</p>
        </section>
      )}

      {kiosk.tags.length > 0 && (
        <section class="border-b-2 border-border p-6">
          <h2 class="mb-3 font-display text-sm tracking-wider uppercase text-fg-muted">Tags</h2>
          <ul class="flex flex-wrap gap-2">
            {kiosk.tags.map((slug) => (
              <li class="border-2 border-border-hi px-2 py-1 text-sm text-fg-muted">
                {tagLabel(slug)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="border-b-2 border-border p-6">
        <h2 class="mb-3 font-display text-sm tracking-wider uppercase text-fg-muted">
          Bewertungen
        </h2>
        <RatingBlock
          kioskId={kiosk.id}
          aggregate={aggregate}
          own={ownRating}
          isLoggedIn={isLoggedIn}
        />
      </section>

      <section class="border-b-2 border-border p-6">
        <h2 class="mb-3 font-display text-sm tracking-wider uppercase text-fg-muted">
          Daten falsch?
        </h2>
        <ReportForm
          kioskId={kiosk.id}
          isLoggedIn={isLoggedIn}
          currentHoursRaw={kiosk.hours?.raw}
        />
      </section>

      <footer class="flex flex-col gap-2 p-6 text-sm text-fg-dim sm:flex-row sm:items-center sm:justify-between">
        <p>
          <span class="text-fg-muted">ID:</span>{" "}
          <code class="font-mono">{kiosk.id}</code>
          {hopfenstopSource && (
            <>
              {" · "}
              <span class="text-fg-muted">Quelle:</span> HopfenStop
            </>
          )}
        </p>
        <a
          href={`https://github.com/boredland/trinkhallen-data/blob/main/data/${kiosk.region}.geojson`}
          target="_blank"
          rel="noopener noreferrer"
          class="text-neon-cyan underline-offset-2 hover:underline"
        >
          Auf GitHub bearbeiten →
        </a>
      </footer>
    </article>
  );
};

const PaymentBadge: FC<{ label: string; icon: string; state: TriState }> = ({
  label,
  icon,
  state,
}) => {
  const cls =
    state === "yes"
      ? "border-success/60 text-success"
      : state === "no"
        ? "border-border text-fg-dim line-through"
        : "border-border text-fg-muted";
  return (
    <span class={`inline-flex items-center gap-1.5 border-2 px-2 py-1 text-sm ${cls}`}>
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </span>
  );
};
