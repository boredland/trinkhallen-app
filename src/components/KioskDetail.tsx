import type { FC } from "hono/jsx";
import type { KioskRecord } from "../lib/db";
import { INTL_LOCALE, type Lang, OH_LABELS, PAYMENT_LABELS, t, tpl } from "../lib/messages";
import { buildNavigateTargets } from "../lib/navigate";
import {
  computeStatus,
  formatHoursTable,
  formatStatus,
  hasPHToken,
  isPublicHolidayToday,
  kioskLocation,
} from "../lib/opening-hours";
import type { Aggregate, RatingComment, RatingRow } from "../lib/ratings";
import type { UserKioskReport } from "../lib/reports";
import { isReportableTag, tagLabel } from "../lib/tags";
import { CheckinForm } from "./CheckinForm";
import { RatingBlock } from "./RatingBlock";
import { ReportForm } from "./ReportForm";

type TriState = "yes" | "no" | "unknown";

const PAYMENT_ICONS: Record<string, string> = {
  cash: "💶",
  cards: "💳",
  contactless: "📲",
  girocard: "🟦",
};
const PAYMENT_ORDER = ["cash", "cards", "contactless", "girocard"] as const;

export interface NearbyKiosk {
  id: string;
  name: string;
  district?: string;
  distance: number;
  lng: number;
  lat: number;
}

export const KioskDetail: FC<{
  lang: Lang;
  kiosk: KioskRecord;
  userAgent: string | null;
  aggregate: Aggregate;
  ownRating: RatingRow | null;
  ratingComments: RatingComment[];
  isLoggedIn: boolean;
  nearby?: NearbyKiosk[];
  userReports?: UserKioskReport[];
}> = ({
  lang,
  kiosk,
  userAgent,
  aggregate,
  ownRating,
  ratingComments,
  isLoggedIn,
  nearby,
  userReports = [],
}) => {
  const loc = kioskLocation(kiosk);
  const now = new Date();
  const status = computeStatus(kiosk.hours?.raw, now, loc);
  const statusLabel = formatStatus(lang, status);
  const hoursTable = formatHoursTable(lang, kiosk.hours?.raw, loc);
  // PH banner condition: today is a Bundesland holiday AND the kiosk has
  // some opening_hours AND those hours carry no explicit PH rule. The
  // status displayed above stays as-is; we don't override it — Spätis are
  // often the holiday exception in BE/NRW so guessing either way is wrong
  // half the time.
  const showPHBanner =
    !!kiosk.hours?.raw && !hasPHToken(kiosk.hours.raw) && isPublicHolidayToday(loc, now);
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
  const osmSource = kiosk.sources?.find((s) => s.type === "osm");

  // Only surface tags from the curated reportable vocabulary — legacy/imported
  // slugs (applewoi, craft_bier, ambiente tags, …) aren't managed, so hide them.
  const managedTags = kiosk.tags.filter(isReportableTag);

  const city = addr["city"];
  // Computed lead sentence — only a fallback. A real, data-provided
  // description always wins, so we don't show both.
  const intro = (() => {
    if (kiosk.description) return null;
    if (city && district)
      return tpl(lang, "kiosk.introCityDistrict", { name: kiosk.name, district, city });
    if (city) return tpl(lang, "kiosk.introCity", { name: kiosk.name, city });
    return null;
  })();
  const updatedDate = kiosk.updatedAt
    ? new Date(kiosk.updatedAt * 1000).toLocaleDateString(INTL_LOCALE[lang], {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : null;

  return (
    <article class="border-2 border-border bg-surface">
      <a
        href="/"
        data-back
        class="block border-b-2 border-border px-6 py-3 font-display text-xs tracking-wider uppercase text-fg-muted transition-colors hover:text-neon-pink"
      >
        {t(lang, "kiosk.backToMap")}
      </a>
      <header class="border-b-2 border-border p-6">
        <p
          class={`mb-3 font-display text-sm tracking-wider uppercase ${
            status.kind === "open"
              ? "text-status-open"
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
        <a href={nav.primary.href} class="btn-neon w-full sm:w-auto" data-navigate-primary>
          {t(lang, "kiosk.navigate")}
        </a>
        <details class="mt-3 text-sm text-fg-muted">
          <summary class="cursor-pointer hover:text-fg">{t(lang, "kiosk.openOtherMaps")}</summary>
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

      {intro && (
        <section class="border-b-2 border-border p-6 text-fg-muted">
          <p class="text-fg">{intro}</p>
        </section>
      )}

      {kiosk.payment && (
        <section class="border-b-2 border-border p-6">
          <h2 class="mb-3 font-display text-sm tracking-wider uppercase text-fg-muted">
            {t(lang, "kiosk.paymentHeading")}
          </h2>
          <ul class="flex flex-wrap gap-2">
            {PAYMENT_ORDER.map((key) => {
              const value = kiosk.payment?.[key] as TriState | undefined;
              if (!value) return null;
              const icon = PAYMENT_ICONS[key];
              if (!icon) return null;
              return (
                <li>
                  <PaymentBadge
                    label={PAYMENT_LABELS[lang][key] ?? key}
                    icon={icon}
                    state={value}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {kiosk.hours?.raw && (
        <section class="border-b-2 border-border p-6">
          <h2 class="mb-2 font-display text-sm tracking-wider uppercase text-fg-muted">
            {t(lang, "kiosk.openingHoursHeading")}
          </h2>
          {showPHBanner && (
            <p class="mb-3 border border-neon-amber/60 bg-neon-amber/10 px-3 py-2 text-sm text-fg">
              {t(lang, "kiosk.phBanner")}
            </p>
          )}
          {hoursTable ? (
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
              {hoursTable.map(({ days, hours }) => (
                <>
                  <dt class="text-fg-dim">{days}</dt>
                  <dd class={hours === OH_LABELS[lang].closedLower ? "text-fg-muted" : "text-fg"}>
                    {hours}
                  </dd>
                </>
              ))}
            </dl>
          ) : (
            <p class="font-mono text-fg">{kiosk.hours.raw}</p>
          )}
        </section>
      )}

      {kiosk.description && (
        <section class="border-b-2 border-border p-6">
          <h2 class="mb-2 font-display text-sm tracking-wider uppercase text-fg-muted">
            {t(lang, "kiosk.descriptionHeading")}
          </h2>
          <p class="text-fg whitespace-pre-line">{kiosk.description}</p>
        </section>
      )}

      {managedTags.length > 0 && (
        <section class="border-b-2 border-border p-6">
          <h2 class="mb-3 font-display text-sm tracking-wider uppercase text-fg-muted">
            {t(lang, "kiosk.tagsHeading")}
          </h2>
          <ul class="flex flex-wrap gap-2">
            {managedTags.map((slug) => (
              <li class="border-2 border-border-hi px-2 py-1 text-sm text-fg-muted">
                {tagLabel(lang, slug)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="border-b-2 border-border p-6">
        <h2 class="mb-3 font-display text-sm tracking-wider uppercase text-fg-muted">
          {t(lang, "kiosk.wereYouHere")}
        </h2>
        <CheckinForm lang={lang} kiosk={kiosk} isLoggedIn={isLoggedIn} userReports={userReports} />
      </section>

      <section class="border-b-2 border-border p-6">
        <h2 class="mb-3 font-display text-sm tracking-wider uppercase text-fg-muted">
          {t(lang, "kiosk.ratingsHeading")}
        </h2>
        <RatingBlock
          lang={lang}
          kioskId={kiosk.id}
          aggregate={aggregate}
          own={ownRating}
          comments={ratingComments}
          isLoggedIn={isLoggedIn}
        />
      </section>

      <section class="border-b-2 border-border p-6">
        <h2 class="mb-3 font-display text-sm tracking-wider uppercase text-fg-muted">
          {t(lang, "kiosk.dataWrong")}
        </h2>
        <ReportForm
          lang={lang}
          kioskId={kiosk.id}
          isLoggedIn={isLoggedIn}
          currentHoursRaw={kiosk.hours?.raw}
          userReports={userReports}
        />
      </section>

      {nearby && nearby.length > 0 && (
        <section class="border-b-2 border-border p-6">
          <h2 class="mb-3 font-display text-sm tracking-wider uppercase text-fg-muted">
            {t(lang, "kiosk.nearbyHeading")}
          </h2>
          <ul class="space-y-2 text-sm">
            {nearby.map((n) => (
              <li class="flex items-baseline justify-between gap-3">
                <a
                  href={`/k/${n.id}`}
                  data-lng={String(n.lng)}
                  data-lat={String(n.lat)}
                  class="text-fg underline-offset-2 hover:text-neon-pink hover:underline"
                >
                  {n.name}
                  {n.district && <span class="text-fg-dim"> · {n.district}</span>}
                </a>
                <span class="font-mono tabular-nums text-xs text-fg-dim">
                  {n.distance < 1000
                    ? `${Math.round(n.distance)} m`
                    : `${(n.distance / 1000).toFixed(1)} km`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer class="flex flex-col gap-2 p-6 text-sm text-fg-dim sm:flex-row sm:items-center sm:justify-between">
        <p>
          <span class="text-fg-muted">{t(lang, "kiosk.idLabel")}</span>{" "}
          <code class="font-mono">{kiosk.id}</code>
          {hopfenstopSource && (
            <>
              {" · "}
              <span class="text-fg-muted">{t(lang, "kiosk.sourceLabel")}</span> HopfenStop
            </>
          )}
          {osmSource && (
            <>
              {" · "}
              <span class="text-fg-muted">{t(lang, "kiosk.sourceLabel")}</span>{" "}
              <a
                class="underline-offset-2 hover:text-neon-cyan hover:underline"
                href={`https://www.openstreetmap.org/${osmSource.id}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                OpenStreetMap
              </a>
              {updatedDate && (
                <>
                  {" · "}
                  <span class="text-fg-muted">{t(lang, "kiosk.updatedLabel")}</span> {updatedDate}
                </>
              )}
            </>
          )}
        </p>
        <a
          href={`https://github.com/boredland/trinkhallen-data/blob/main/data/${kiosk.region}.geojson`}
          target="_blank"
          rel="noopener noreferrer"
          class="text-neon-cyan underline-offset-2 hover:underline"
        >
          {t(lang, "kiosk.editOnGithub")}
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
