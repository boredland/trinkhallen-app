import type { FC } from "hono/jsx";
import type { KioskRecord } from "../lib/db";
import { formatDistance, haversineMeters, type LatLng } from "../lib/geo";
import { type Lang, pathForLang, paymentLabel, t, tpl } from "../lib/messages";
import { buildNavigateTargets } from "../lib/navigate";
import { computeStatus, formatStatus, kioskLocation } from "../lib/opening-hours";
import { tagLabel } from "../lib/tags";

// Row indicators surface things a user scans for at a glance: can I pay
// with a card (girocard counts; see lib/filters.ts), is there a toilet.
// "Bar" and "Kontaktlos" used to live here too — dropped because cash is
// the default expectation and contactless is now folded into "Karte".
const CARD_KEYS = ["cards", "contactless", "girocard"] as const;

export interface KioskListProps {
  lang: Lang;
  kiosks: KioskRecord[];
  totalInBbox: number;
  filteredCount: number;
  /** Number of kiosks in the current list whose hours.raw evaluates to
   *  "open right now". Surfaces an "X offen jetzt" badge in the header so
   *  the in-a-hurry persona has a glanceable answer above the fold. */
  openNowCount?: number;
  /** When set, list items render a distance label. Sorting happens upstream. */
  origin?: LatLng | undefined;
  /** When true, render a "× Filter zurücksetzen" link in the count row. */
  filterActive?: boolean;
  /** Where the reset link points; usually the host page sans query. */
  resetHref?: string;
  userAgent: string | null;
}

export const KioskList: FC<KioskListProps> = ({
  lang,
  kiosks,
  totalInBbox,
  filteredCount,
  openNowCount,
  filterActive = false,
  resetHref,
  origin,
  userAgent,
}) => {
  const isFiltered = filteredCount !== totalInBbox || filterActive;
  const countLabel =
    filteredCount === totalInBbox
      ? tpl(lang, "kioskList.countAll", {
          n: filteredCount,
          suffix: filteredCount === 1 ? "" : lang === "en" ? "s" : "n",
        })
      : tpl(lang, "kioskList.countFiltered", { filtered: filteredCount, total: totalInBbox });

  if (kiosks.length === 0) {
    return (
      <div class="p-6 text-fg-muted">
        <p class="font-display text-xl tracking-wide text-fg">
          {t(lang, "kioskList.nothingFound")}
        </p>
        <p class="mt-2 text-sm">{t(lang, "kioskList.nothingHint")}</p>
        {isFiltered && resetHref && (
          <a
            href={resetHref}
            class="mt-3 inline-block text-sm text-neon-cyan underline-offset-2 hover:underline"
          >
            {t(lang, "kioskList.resetLong")}
          </a>
        )}
      </div>
    );
  }

  return (
    // The scrolling parent is the `<aside data-sidebar>` two levels up:
    // a single scroll container per device, which Safari Mobile is happy
    // to drive with native flicks. The aside also owns its own sticky
    // chip-header, so this count row stays inline (a second sticky in
    // the same scroll container would just overlap the chip header).
    <div class="block">
      <div class="flex items-center justify-between border-b-2 border-border px-4 py-2 text-xs uppercase tracking-wider">
        <span class={isFiltered ? "text-neon-pink" : "text-fg-dim"}>
          {countLabel}
          {typeof openNowCount === "number" && openNowCount > 0 && (
            <span class="ml-2 text-status-open">
              ▶▶▶ {tpl(lang, "kioskList.openNow", { n: openNowCount })}
            </span>
          )}
        </span>
        {isFiltered && resetHref && (
          <a
            href={resetHref}
            class="text-fg-muted hover:text-neon-pink"
            aria-label={t(lang, "kioskList.resetAria")}
          >
            {t(lang, "kioskList.resetShort")}
          </a>
        )}
      </div>
      <ul class="divide-y-2 divide-border">
        {kiosks.map((k) => (
          <KioskRow lang={lang} kiosk={k} userAgent={userAgent} origin={origin} />
        ))}
      </ul>
    </div>
  );
};

const KioskRow: FC<{
  lang: Lang;
  kiosk: KioskRecord;
  userAgent: string | null;
  origin?: LatLng | undefined;
}> = ({ lang, kiosk, userAgent, origin }) => {
  const status = computeStatus(kiosk.hours?.raw, new Date(), kioskLocation(kiosk));
  const nav = buildNavigateTargets({
    name: kiosk.name,
    lat: kiosk.lat,
    lng: kiosk.lng,
    userAgent,
  });
  const street = kiosk.address["street"];
  const number = kiosk.address["number"];
  const district = kiosk.address["district"];
  const addr = [street && number ? `${street} ${number}` : street, district]
    .filter(Boolean)
    .join(" · ");
  const distLabel = origin
    ? formatDistance(haversineMeters(origin, { lat: kiosk.lat, lng: kiosk.lng }))
    : null;

  return (
    <li>
      <div class="flex items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-surface-2">
        <a
          href={pathForLang(`/k/${kiosk.id}`, lang)}
          data-lng={kiosk.lng}
          data-lat={kiosk.lat}
          class="flex-1 min-w-0"
        >
          <p class="truncate font-display text-base tracking-wide text-fg">{kiosk.name}</p>
          {addr && <p class="truncate text-sm text-fg-muted">{addr}</p>}
          <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <span
              class={
                status.kind === "open"
                  ? "text-status-open"
                  : status.kind === "closed"
                    ? "text-fg-dim"
                    : "text-fg-muted"
              }
            >
              {status.kind === "open" ? "▶▶▶ " : status.kind === "closed" ? "■ " : "… "}
              {formatStatus(lang, status)}
            </span>
            {distLabel && (
              <span
                class="font-mono tabular-nums text-neon-cyan"
                aria-label={t(lang, "kioskList.distanceAria")}
              >
                · {distLabel}
              </span>
            )}
            {(() => {
              const acceptsCard = CARD_KEYS.some((k) => kiosk.payment?.[k] === "yes");
              const hasWc = kiosk.tags.includes("wc");
              const hasSeating = kiosk.tags.includes("sitzgelegenheiten");
              if (!acceptsCard && !hasWc && !hasSeating) return null;
              return (
                <span class="flex items-center gap-1 text-fg-dim">
                  {acceptsCard && (
                    <span
                      aria-label={paymentLabel(lang, "cards")}
                      title={paymentLabel(lang, "cards")}
                    >
                      💳
                    </span>
                  )}
                  {hasSeating && (
                    <span
                      aria-label={tagLabel(lang, "sitzgelegenheiten")}
                      title={tagLabel(lang, "sitzgelegenheiten")}
                    >
                      🪑
                    </span>
                  )}
                  {hasWc && (
                    <span aria-label={tagLabel(lang, "wc")} title={tagLabel(lang, "wc")}>
                      🚻
                    </span>
                  )}
                </span>
              );
            })()}
          </div>
        </a>
        <a
          href={nav.primary.href}
          class="shrink-0 border-2 border-border-hi px-2 py-1 font-display text-xs tracking-wider uppercase text-fg-muted transition-colors hover:border-neon-pink hover:text-neon-pink"
          aria-label={tpl(lang, "kioskList.navTo", { name: kiosk.name })}
        >
          {t(lang, "kioskList.nav")}
        </a>
      </div>
    </li>
  );
};
