import type { FC } from "hono/jsx";
import type { KioskFilter } from "../lib/filters";

export interface FilterChipsProps {
  filter: KioskFilter;
  /** Where filter changes submit to. The form mutates the URL ?params. */
  formAction: string;
  /** Hidden inputs for params we want preserved across submits (e.g. bbox). */
  preserve?: Record<string, string | undefined>;
}

/**
 * Filter chips render as a <form> with checkbox-styled buttons. JS in
 * client/app.entry.ts intercepts changes to submit without a full reload and
 * dispatches a `tk:filters-changed` event that the map listens for.
 */
export const FilterChips: FC<FilterChipsProps> = ({ filter, formAction, preserve = {} }) => {
  const payCsv = [
    filter.payment.cards ? "cards" : null,
    filter.payment.contactless ? "contactless" : null,
    filter.payment.cash ? "cash" : null,
  ]
    .filter(Boolean)
    .join(",");

  return (
    <form
      action={formAction}
      method="get"
      class="flex flex-wrap items-center gap-2"
      data-filter-form
    >
      {Object.entries(preserve).map(([k, v]) =>
        v !== undefined ? <input type="hidden" name={k} value={v} /> : null,
      )}

      <Chip name="open_now" value="1" checked={filter.openNow} icon="▶▶▶" label="Offen jetzt" />
      <Chip
        name="needs_hours"
        value="1"
        checked={filter.needsHours}
        icon="❓"
        label="Zeiten fehlen"
      />
      {/* One "Karte" chip covers cards + contactless — same intent ("can I
          pay without cash?"), the apply layer merges them. Cash is not
          worth a chip (default assumption everywhere) and the indoor
          tag isn't a query users actually run. */}
      <PaymentChip current={payCsv} value="cards" label="Karte" icon="💳" />

      <TagChip tags={filter.tags} value="wc" label="WC" icon="🚻" />
      <TagChip tags={filter.tags} value="sitzgelegenheiten" label="Sitzen" icon="🪑" />

      {/* Search box collapses to icon on mobile via CSS-only :checked toggle */}
      <label class="ml-auto flex items-center gap-1 border-2 border-border bg-surface px-2 py-1 text-sm">
        <span aria-hidden="true">🔎</span>
        <input
          type="search"
          name="q"
          placeholder="Suchen…"
          value={filter.q ?? ""}
          class="w-32 bg-transparent text-fg placeholder:text-fg-dim focus:outline-none"
        />
      </label>

      <noscript>
        <button type="submit" class="btn-neon">
          Filter anwenden
        </button>
      </noscript>
    </form>
  );
};

const Chip: FC<{
  name: string;
  value: string;
  checked: boolean;
  icon?: string;
  label: string;
}> = ({ name, value, checked, icon, label }) => (
  // Style flows from the checkbox's live :checked state (via :has() on the
  // label, peer-checked: on the icon) — not from the SSR-time `checked`
  // prop. That way a toggle updates the visual immediately, before the
  // change handler in app.entry.ts has even fired the query refresh.
  <label class="inline-flex cursor-pointer select-none items-center gap-1.5 border-2 border-border bg-transparent px-2 py-1 text-sm font-medium text-fg-dim transition-colors hover:border-border-hi hover:text-fg has-checked:border-neon-pink has-checked:bg-neon-pink has-checked:text-bg has-checked:shadow-[var(--shadow-glow-pink)]">
    <input type="checkbox" name={name} value={value} checked={checked} class="peer sr-only" />
    {icon && (
      <span
        aria-hidden="true"
        class="opacity-50 grayscale transition peer-checked:opacity-100 peer-checked:grayscale-0"
      >
        {icon}
      </span>
    )}
    <span>{label}</span>
  </label>
);

/** Payment chip toggles one entry inside the `pay` CSV. */
const PaymentChip: FC<{ current: string; value: string; label: string; icon: string }> = ({
  current,
  value,
  label,
  icon,
}) => {
  const has = current.split(",").includes(value);
  return <Chip name={`pay_${value}`} value="1" checked={has} icon={icon} label={label} />;
};

const TagChip: FC<{ tags: string[]; value: string; label: string; icon?: string }> = ({
  tags,
  value,
  label,
  icon,
}) => (
  <Chip name={`tag_${value}`} value="1" checked={tags.includes(value)} icon={icon} label={label} />
);
