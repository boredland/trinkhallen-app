import type { FC } from "hono/jsx";
import type { KioskRecord } from "../lib/db";
import { formatDistance, haversineMeters, type LatLng } from "../lib/geo";
import { buildNavigateTargets } from "../lib/navigate";
import { computeStatus, formatStatus } from "../lib/opening-hours";

const PAY_ICONS: Array<{ key: "cards" | "contactless" | "cash"; icon: string; label: string }> = [
  { key: "cards", icon: "💳", label: "Karte" },
  { key: "contactless", icon: "📲", label: "Kontaktlos" },
  { key: "cash", icon: "💶", label: "Bar" },
];

export interface KioskListProps {
  kiosks: KioskRecord[];
  totalInBbox: number;
  filteredCount: number;
  /** When set, list items render a distance label. Sorting happens upstream. */
  origin?: LatLng | undefined;
  /** Wraps the list — defaults to a vertical scroll. The /list page uses block. */
  variant?: "panel" | "page";
  /** When true, render a "× Filter zurücksetzen" link in the count row. */
  filterActive?: boolean;
  /** Where the reset link points; usually the host page sans query. */
  resetHref?: string;
  userAgent: string | null;
}

export const KioskList: FC<KioskListProps> = ({
  kiosks,
  totalInBbox,
  filteredCount,
  variant = "panel",
  filterActive = false,
  resetHref,
  origin,
  userAgent,
}) => {
  const isFiltered = filteredCount !== totalInBbox || filterActive;
  const countLabel =
    filteredCount === totalInBbox
      ? `${filteredCount} Trinkhalle${filteredCount === 1 ? "" : "n"}`
      : `${filteredCount} / ${totalInBbox} (gefiltert)`;

  if (kiosks.length === 0) {
    return (
      <div class="p-6 text-fg-muted">
        <p class="font-display text-xl tracking-wide text-fg">… nichts gefunden</p>
        <p class="mt-2 text-sm">
          Keine Trinkhallen in diesem Bereich – zoom raus oder lockere die Filter.
        </p>
        {isFiltered && resetHref && (
          <a
            href={resetHref}
            class="mt-3 inline-block text-sm text-neon-cyan underline-offset-2 hover:underline"
          >
            × Filter zurücksetzen
          </a>
        )}
      </div>
    );
  }

  return (
    // min-h-0 on the outer flex container is required so the inner overflow-y-auto
    // ul can actually scroll inside a flex parent; without it flex children default
    // to min-height: auto (content-size) and the list grows past the viewport.
    <div class={variant === "panel" ? "flex h-full min-h-0 flex-col" : "block"}>
      <div class="flex items-center justify-between border-b-2 border-border px-4 py-2 text-xs uppercase tracking-wider">
        <span class={isFiltered ? "text-neon-pink" : "text-fg-dim"}>{countLabel}</span>
        {isFiltered && resetHref && (
          <a
            href={resetHref}
            class="text-fg-muted hover:text-neon-pink"
            aria-label="Filter zurücksetzen"
          >
            × Reset
          </a>
        )}
      </div>
      <ul
        class={
          variant === "panel"
            ? "min-h-0 flex-1 divide-y-2 divide-border overflow-y-auto overscroll-contain"
            : "divide-y-2 divide-border"
        }
      >
        {kiosks.map((k) => (
          <KioskRow kiosk={k} userAgent={userAgent} origin={origin} />
        ))}
      </ul>
    </div>
  );
};

const KioskRow: FC<{
  kiosk: KioskRecord;
  userAgent: string | null;
  origin?: LatLng | undefined;
}> = ({ kiosk, userAgent, origin }) => {
  const status = computeStatus(kiosk.hours?.raw);
  const nav = buildNavigateTargets({
    name: kiosk.name,
    lat: kiosk.lat,
    lng: kiosk.lng,
    userAgent,
  });
  const street = kiosk.address["street"];
  const number = kiosk.address["number"];
  const district = kiosk.address["district"];
  const addr = [street && number ? `${street} ${number}` : street, district].filter(Boolean).join(" · ");
  const distLabel = origin ? formatDistance(haversineMeters(origin, { lat: kiosk.lat, lng: kiosk.lng })) : null;

  return (
    <li>
      <div class="flex items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-surface-2">
        <a
          href={`/k/${kiosk.id}`}
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
              {formatStatus(status)}
            </span>
            {distLabel && (
              <span class="font-mono tabular-nums text-neon-cyan" aria-label="Entfernung">
                · {distLabel}
              </span>
            )}
            {kiosk.payment && (
              <span class="flex items-center gap-1 text-fg-dim">
                {PAY_ICONS.filter(({ key }) => kiosk.payment?.[key] === "yes").map(({ icon, label }) => (
                  <span aria-label={label} title={label}>
                    {icon}
                  </span>
                ))}
              </span>
            )}
          </div>
        </a>
        <a
          href={nav.primary.href}
          class="shrink-0 border-2 border-border-hi px-2 py-1 font-display text-xs tracking-wider uppercase text-fg-muted transition-colors hover:border-neon-pink hover:text-neon-pink"
          aria-label={`Hin navigieren zu ${kiosk.name}`}
        >
          ▶ Nav
        </a>
      </div>
    </li>
  );
};
