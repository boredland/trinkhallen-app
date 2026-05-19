import type { FC } from "hono/jsx";
import type { KioskRecord } from "../lib/db";
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
  /** When set, list items expose distance from this point. */
  origin?: { lat: number; lng: number } | undefined;
  /** Wraps the list — defaults to a vertical scroll. The /list page uses block. */
  variant?: "panel" | "page";
  userAgent: string | null;
}

export const KioskList: FC<KioskListProps> = ({
  kiosks,
  totalInBbox,
  filteredCount,
  variant = "panel",
  userAgent,
}) => {
  if (kiosks.length === 0) {
    return (
      <div class="p-6 text-fg-muted">
        <p class="font-display text-xl tracking-wide text-fg">… nichts gefunden</p>
        <p class="mt-2 text-sm">
          Keine Trinkhallen in diesem Bereich – zoom raus oder lockere die Filter.
        </p>
      </div>
    );
  }

  return (
    <div class={variant === "panel" ? "flex h-full flex-col" : "block"}>
      <p class="border-b-2 border-border px-4 py-2 text-xs uppercase tracking-wider text-fg-dim">
        {filteredCount === totalInBbox
          ? `${filteredCount} Trinkhalle${filteredCount === 1 ? "" : "n"}`
          : `${filteredCount} / ${totalInBbox} (gefiltert)`}
      </p>
      <ul
        class={
          variant === "panel"
            ? "flex-1 divide-y-2 divide-border overflow-y-auto"
            : "divide-y-2 divide-border"
        }
      >
        {kiosks.map((k) => (
          <KioskRow kiosk={k} userAgent={userAgent} />
        ))}
      </ul>
    </div>
  );
};

const KioskRow: FC<{ kiosk: KioskRecord; userAgent: string | null }> = ({ kiosk, userAgent }) => {
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

  return (
    <li>
      <div class="flex items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-surface-2">
        <a href={`/k/${kiosk.id}`} class="flex-1 min-w-0">
          <p class="truncate font-display text-base tracking-wide text-fg">{kiosk.name}</p>
          {addr && <p class="truncate text-sm text-fg-muted">{addr}</p>}
          <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <span
              class={
                status.kind === "open"
                  ? "text-neon-amber"
                  : status.kind === "closed"
                    ? "text-fg-dim"
                    : "text-fg-muted"
              }
            >
              {status.kind === "open" ? "▶▶▶ " : status.kind === "closed" ? "■ " : "… "}
              {formatStatus(status)}
            </span>
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
