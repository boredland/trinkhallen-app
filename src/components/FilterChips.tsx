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
      <PaymentChip current={payCsv} value="cards" label="Karte" icon="💳" />
      <PaymentChip current={payCsv} value="contactless" label="Kontaktlos" icon="📲" />
      <PaymentChip current={payCsv} value="cash" label="Bar" icon="💶" />

      <TagChip tags={filter.tags} value="wc" label="WC" />
      <TagChip tags={filter.tags} value="sitzgelegenheiten" label="Sitzen" />
      <TagChip tags={filter.tags} value="innenraum" label="Innen" />

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
  <label
    class={`inline-flex cursor-pointer select-none items-center gap-1.5 border-2 px-2 py-1 text-sm font-medium transition-colors ${
      checked
        ? "border-neon-pink bg-neon-pink text-bg shadow-[var(--shadow-glow-pink)]"
        : "border-border-hi bg-surface text-fg-muted hover:border-fg-muted hover:text-fg"
    }`}
  >
    <input type="checkbox" name={name} value={value} checked={checked} class="sr-only" />
    {icon && <span aria-hidden="true">{icon}</span>}
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

const TagChip: FC<{ tags: string[]; value: string; label: string }> = ({ tags, value, label }) => (
  <Chip name={`tag_${value}`} value="1" checked={tags.includes(value)} label={label} />
);
