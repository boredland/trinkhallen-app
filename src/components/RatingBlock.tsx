import type { FC } from "hono/jsx";
import { INTL_LOCALE, type Lang, t, tpl } from "../lib/messages";
import type { Aggregate, RatingComment, RatingRow } from "../lib/ratings";

export interface RatingBlockProps {
  lang: Lang;
  kioskId: string;
  aggregate: Aggregate;
  own: RatingRow | null;
  comments: RatingComment[];
  isLoggedIn: boolean;
}

/**
 * Renders the aggregate + written comments + (when logged in) the interactive
 * star form. `id="rating-block"` is the HTMX swap target — POST /api/ratings
 * returns the exact same fragment to replace it.
 */
export const RatingBlock: FC<RatingBlockProps> = ({
  lang,
  kioskId,
  aggregate,
  own,
  comments,
  isLoggedIn,
}) => {
  return (
    <div id="rating-block" class="space-y-5">
      <AggregateView lang={lang} aggregate={aggregate} />
      <CommentsList lang={lang} comments={comments} />
      {isLoggedIn ? (
        <OwnRatingForm lang={lang} kioskId={kioskId} own={own} />
      ) : (
        <LoggedOutCta lang={lang} />
      )}
    </div>
  );
};

const CommentsList: FC<{ lang: Lang; comments: RatingComment[] }> = ({ lang, comments }) => {
  if (comments.length === 0) return null;
  return (
    <ul class="space-y-3 border-t-2 border-border pt-4">
      {comments.map((c) => (
        <li class="space-y-1">
          <div class="flex flex-wrap items-center gap-x-2 text-sm">
            <span aria-label={tpl(lang, "rating.starsOfFive", { n: c.stars })}>
              <span class="text-neon-amber">{"★".repeat(c.stars)}</span>
              <span class="text-fg-dim">{"★".repeat(5 - c.stars)}</span>
            </span>
            <span class="font-display text-xs tracking-wider uppercase text-fg-muted">
              {c.author}
            </span>
            <span class="ml-auto text-xs text-fg-dim">{fmtDate(lang, c.updatedAt)}</span>
          </div>
          <p class="whitespace-pre-line text-sm text-fg">{c.comment}</p>
        </li>
      ))}
    </ul>
  );
};

function fmtDate(lang: Lang, unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(INTL_LOCALE[lang], {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

const AggregateView: FC<{ lang: Lang; aggregate: Aggregate }> = ({ lang, aggregate }) => {
  if (aggregate.count === 0) {
    return <p class="text-fg-muted">{t(lang, "rating.noneYet")}</p>;
  }
  return (
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div class="font-display text-fg">
        <span class="text-4xl text-neon-amber">{aggregate.avg.toFixed(1)}</span>
        <span class="ml-1 text-sm text-fg-muted">/ 5</span>
        <p class="text-sm text-fg-dim">
          {tpl(lang, "rating.count", {
            n: aggregate.count,
            suffix: aggregate.count === 1 ? "" : "en",
          })}
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
                <span class="absolute inset-y-0 left-0 bg-neon-amber" style={`width: ${pct}%`} />
              </span>
              <span class="w-8 text-right tabular-nums">{n}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const OwnRatingForm: FC<{ lang: Lang; kioskId: string; own: RatingRow | null }> = ({
  lang,
  kioskId,
  own,
}) => (
  <form
    action={`/api/ratings`}
    method="post"
    class="space-y-3 border-t-2 border-border pt-4"
    data-rating-form
  >
    <input type="hidden" name="kiosk_id" value={kioskId} />
    <p class="font-display text-sm tracking-wider uppercase text-fg-muted">
      {own ? t(lang, "rating.yours") : t(lang, "rating.rate")}
    </p>
    <Stars lang={lang} current={own?.stars ?? 0} />
    <p data-rating-error hidden class="text-sm text-danger" aria-live="polite" />
    <label class="block">
      <span class="sr-only">{t(lang, "rating.commentSr")}</span>
      <textarea
        name="comment"
        rows={2}
        maxLength={500}
        placeholder={t(lang, "rating.commentPlaceholder")}
        class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
      >
        {own?.comment ?? ""}
      </textarea>
    </label>
    <div class="flex flex-wrap gap-2">
      <button type="submit" class="btn-neon">
        ▶ {own ? t(lang, "rating.update") : t(lang, "rating.submit")}
      </button>
      {own && (
        <button
          type="submit"
          formaction="/api/ratings/delete"
          class="cursor-pointer border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wider uppercase text-fg-muted hover:border-danger hover:text-danger"
        >
          {t(lang, "rating.delete")}
        </button>
      )}
    </div>
  </form>
);

const Stars: FC<{ lang: Lang; current: number }> = ({ lang, current }) => (
  <div
    role="radiogroup"
    aria-label={t(lang, "rating.starsAria")}
    class="flex items-center gap-1 text-2xl"
    data-stars-group
  >
    {[1, 2, 3, 4, 5].map((star) => {
      const active = star <= current;
      return (
        <label class="cursor-pointer">
          {/* No `required`: these radios are sr-only, so an unfilled-required
              submit blocks natively but the validation bubble can't render
              off-screen — the submit event never fires and the button looks
              dead. We validate star selection in rating.ts instead. */}
          <input
            type="radio"
            name="stars"
            value={star}
            checked={active && star === current}
            class="sr-only"
          />
          <span
            aria-hidden="true"
            class={`transition-colors ${active ? "text-neon-amber" : "text-fg-dim hover:text-neon-amber/60"}`}
            data-star-value={star}
          >
            ★
          </span>
          <span class="sr-only">{tpl(lang, "rating.nStars", { n: star })}</span>
        </label>
      );
    })}
  </div>
);

const LoggedOutCta: FC<{ lang: Lang }> = ({ lang }) => (
  <div class="border-t-2 border-border pt-4 text-sm text-fg-muted">
    <a href="/me" class="text-neon-cyan underline-offset-2 hover:underline">
      {t(lang, "auth.login")}
    </a>
    {t(lang, "rating.loginToRateTail")}
  </div>
);
