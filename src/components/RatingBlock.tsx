import type { FC } from "hono/jsx";
import type { Aggregate, RatingRow } from "../lib/ratings";

export interface RatingBlockProps {
  kioskId: string;
  aggregate: Aggregate;
  own: RatingRow | null;
  isLoggedIn: boolean;
}

/**
 * Renders the aggregate + (when logged in) the interactive star form.
 * `id="rating-block"` is the HTMX swap target — POST /api/ratings returns the
 * exact same fragment to replace it.
 */
export const RatingBlock: FC<RatingBlockProps> = ({ kioskId, aggregate, own, isLoggedIn }) => {
  return (
    <div id="rating-block" class="space-y-5">
      <Aggregate aggregate={aggregate} />
      {isLoggedIn ? <OwnRatingForm kioskId={kioskId} own={own} /> : <LoggedOutCta />}
    </div>
  );
};

const Aggregate: FC<{ aggregate: Aggregate }> = ({ aggregate }) => {
  if (aggregate.count === 0) {
    return (
      <p class="text-fg-muted">Noch keine Bewertungen — sei die erste Person.</p>
    );
  }
  return (
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div class="font-display text-fg">
        <span class="text-4xl text-neon-amber">{aggregate.avg.toFixed(1)}</span>
        <span class="ml-1 text-sm text-fg-muted">/ 5</span>
        <p class="text-sm text-fg-dim">
          {aggregate.count} Bewertung{aggregate.count === 1 ? "" : "en"}
        </p>
      </div>
      <ul class="flex-1 space-y-0.5">
        {[5, 4, 3, 2, 1].map((star) => {
          const n = aggregate.histogram[star - 1]!;
          const pct = aggregate.count === 0 ? 0 : Math.round((n / aggregate.count) * 100);
          return (
            <li class="flex items-center gap-2 text-xs text-fg-dim">
              <span class="w-3 text-fg-muted">{star}</span>
              <span class="relative h-2 flex-1 overflow-hidden border border-border bg-bg">
                <span
                  class="absolute inset-y-0 left-0 bg-neon-amber"
                  style={`width: ${pct}%`}
                />
              </span>
              <span class="w-8 text-right tabular-nums">{n}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const OwnRatingForm: FC<{ kioskId: string; own: RatingRow | null }> = ({ kioskId, own }) => (
  <form
    action={`/api/ratings`}
    method="post"
    class="space-y-3 border-t-2 border-border pt-4"
    data-rating-form
  >
    <input type="hidden" name="kiosk_id" value={kioskId} />
    <p class="font-display text-sm tracking-wider uppercase text-fg-muted">
      {own ? "Deine Bewertung" : "Bewerten"}
    </p>
    <Stars current={own?.stars ?? 0} />
    <label class="block">
      <span class="sr-only">Kommentar</span>
      <textarea
        name="comment"
        rows={2}
        maxLength={500}
        placeholder="Optionaler Kommentar (max. 500 Zeichen)"
        class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
      >
        {own?.comment ?? ""}
      </textarea>
    </label>
    <div class="flex flex-wrap gap-2">
      <button
        type="submit"
        class="btn-neon"
      >
        ▶ {own ? "Aktualisieren" : "Abgeben"}
      </button>
      {own && (
        <button
          type="submit"
          formaction="/api/ratings/delete"
          class="border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wider uppercase text-fg-muted hover:border-danger hover:text-danger"
        >
          Löschen
        </button>
      )}
    </div>
  </form>
);

const Stars: FC<{ current: number }> = ({ current }) => (
  <div
    role="radiogroup"
    aria-label="Sterne"
    class="flex items-center gap-1 text-2xl"
    data-stars-group
  >
    {[1, 2, 3, 4, 5].map((star) => {
      const active = star <= current;
      return (
        <label class="cursor-pointer">
          <input
            type="radio"
            name="stars"
            value={star}
            checked={active && star === current}
            required
            class="sr-only"
          />
          <span
            aria-hidden="true"
            class={`transition-colors ${active ? "text-neon-amber" : "text-fg-dim hover:text-neon-amber/60"}`}
            data-star-value={star}
          >
            ★
          </span>
          <span class="sr-only">{star} Sterne</span>
        </label>
      );
    })}
  </div>
);

const LoggedOutCta: FC = () => (
  <div class="border-t-2 border-border pt-4 text-sm text-fg-muted">
    <a href="/me" class="text-neon-cyan underline-offset-2 hover:underline">
      Anmelden
    </a>
    , um diesen Späti zu bewerten.
  </div>
);
