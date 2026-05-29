import type { FC } from "hono/jsx";
import type { KioskRecord } from "../lib/db";
import { type Lang, PAYMENT_LABELS, pathForLang, t } from "../lib/messages";
import { kindLabel, statusLabel, type UserKioskReport } from "../lib/reports";
import { REPORTABLE_TAG_GROUPS, tagGroupLabel, tagLabel } from "../lib/tags";

/**
 * Check-in + gap-fill island.
 *
 * Two visual states:
 *   1. Collapsed (initial): just the "Ich war hier" button. Tap → POSTs a
 *      check-in to /api/checkins (best-effort geolocation) and reveals the
 *      question block. See src/client/checkin.ts for the JS side.
 *   2. Expanded: one form per question group, each posting to /api/reports
 *      via HTMX and swapping itself out for a "Danke!" fragment on success.
 *
 * Gap detection runs at render time: groups whose fields are already filled
 * in on the kiosk don't render at all. The amenity group is always shown
 * because it's not visible whether the *absence* of a tag means "kiosk has
 * none" or "nobody answered yet".
 */

const PAYMENT_ICONS: Record<string, string> = {
  cards: "💳",
  contactless: "📲",
  girocard: "🟦",
};
// Cash is the implicit German default — the enrichment never records it, so
// asking "Bar?" on every kiosk is just noise. The "can I pay without cash?"
// signal lives in cards/contactless/girocard.
const PAYMENT_ORDER = ["cards", "contactless", "girocard"] as const;

const TAG_ICONS: Record<string, string> = {
  backwaren: "🥨",
  eis: "🍦",
  zeitungen: "📰",
  gemischte_tuete: "🍬",
  gluecksspiele: "🎰",
  innenraum: "🏠",
  stehtisch: "🧍",
  ueberdacht: "☂️",
  wc: "🚻",
  barrierefrei: "♿",
  paketshop: "📦",
  wlan: "📶",
  geldautomat: "🏧",
};

/**
 * The confirm + dispute action pair rendered inside every `data-confirm-block`.
 * Both buttons share the same `data-field-key`; the client distinguishes via
 * the `data-signal-confirm` vs `data-signal-dispute` attribute and POSTs to
 * /api/signals with action='confirm' / 'dispute' accordingly.
 */
const ConfirmDisputeButtons: FC<{ lang: Lang; fieldKey: string }> = ({ lang, fieldKey }) => (
  <div class="flex flex-wrap gap-2">
    <button
      type="button"
      data-signal-confirm
      data-field-key={fieldKey}
      class="inline-flex cursor-pointer items-center gap-2 border-2 border-neon-cyan px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-neon-cyan hover:bg-neon-cyan hover:text-bg disabled:opacity-60"
    >
      <span aria-hidden="true">✓</span>
      {t(lang, "checkin.confirm")}
    </button>
    <button
      type="button"
      data-signal-dispute
      data-field-key={fieldKey}
      class="inline-flex cursor-pointer items-center gap-2 border-2 border-border-hi px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-fg-muted hover:border-danger hover:text-danger disabled:opacity-60"
    >
      <span aria-hidden="true">✕</span>
      {t(lang, "checkin.dispute")}
    </button>
  </div>
);

export const CheckinForm: FC<{
  lang: Lang;
  kiosk: KioskRecord;
  isLoggedIn: boolean;
  userReports?: UserKioskReport[];
}> = ({ lang, kiosk, isLoggedIn, userReports = [] }) => {
  if (!isLoggedIn) {
    return (
      <p class="text-sm text-fg-muted">
        <a
          href={pathForLang("/me", lang)}
          class="text-neon-cyan underline-offset-2 hover:underline"
        >
          {t(lang, "auth.login")}
        </a>
        , {t(lang, "checkin.loginToContribute")}
      </p>
    );
  }

  const hoursMissing = !kiosk.hours?.raw;
  // A settled yes/no answers the question; absent *and* "unknown" are gaps the
  // check-in should crowdsource (enrichment writes "unknown" placeholders).
  const missingPayment = PAYMENT_ORDER.filter(
    (k) => kiosk.payment?.[k] !== "yes" && kiosk.payment?.[k] !== "no",
  );
  // The complement: methods with a settled yes/no value, eligible for a
  // "Stimmt's noch?" confirm signal (Phase 0 of the Frische epic).
  const settledPayment = PAYMENT_ORDER.filter(
    (k) => kiosk.payment?.[k] === "yes" || kiosk.payment?.[k] === "no",
  );
  // A group is "answered" by this user when there's a non-rejected report
  // of that kind in flight — hide the form, swap in a "Danke!" stub
  // mirroring what client/checkin.ts renders right after a fresh submit.
  const reportByKind = new Map(userReports.map((r) => [r.kind, r]));
  const isAnswered = (kind: string): boolean => reportByKind.has(kind);

  return (
    <div data-checkin data-kiosk-id={kiosk.id} class="space-y-4">
      <button
        type="button"
        data-checkin-button
        class="inline-flex cursor-pointer items-center gap-2 border-2 border-neon-pink bg-neon-pink px-4 py-2 text-sm font-bold uppercase tracking-wider text-bg shadow-[var(--shadow-glow-pink)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60"
      >
        {/* Monochrome glyph (not a coloured emoji) so it inherits the dark
            button text and stays legible on the neon-pink fill. */}
        <span aria-hidden="true">✓</span>
        {t(lang, "checkin.iWasHere")}
      </button>

      <div data-checkin-questions hidden class="space-y-5">
        <p class="text-sm text-fg-dim">{t(lang, "checkin.whatMissingHint")}</p>

        {hoursMissing &&
          (isAnswered("wrong_hours") ? (
            <AnsweredStub lang={lang} report={reportByKind.get("wrong_hours")!} />
          ) : (
            <HoursGroup lang={lang} kioskId={kiosk.id} />
          ))}
        {kiosk.hours?.raw && (
          <div
            data-confirm-block
            data-field-key="opening_hours"
            class="space-y-2 border-2 border-border-hi bg-surface-2 p-4"
          >
            <p class="text-sm text-fg-muted">{t(lang, "checkin.hoursOk")}</p>
            <p class="font-mono text-sm text-fg">{kiosk.hours.raw}</p>
            <ConfirmDisputeButtons lang={lang} fieldKey="opening_hours" />
          </div>
        )}
        {missingPayment.length > 0 &&
          (isAnswered("update_payment") ? (
            <AnsweredStub lang={lang} report={reportByKind.get("update_payment")!} />
          ) : (
            <PaymentGroup lang={lang} kioskId={kiosk.id} missing={missingPayment} />
          ))}
        {settledPayment.length > 0 && (
          <div
            data-confirm-block
            data-field-key="payment"
            class="space-y-2 border-2 border-border-hi bg-surface-2 p-4"
          >
            <p class="text-sm text-fg-muted">{t(lang, "checkin.paymentOk")}</p>
            <p class="font-mono text-sm text-fg">
              {settledPayment
                .map(
                  (k) =>
                    `${PAYMENT_LABELS[lang][k] ?? k}: ${
                      kiosk.payment?.[k] === "yes"
                        ? t(lang, "payment.yesLower")
                        : t(lang, "payment.noLower")
                    }`,
                )
                .join(" · ")}
            </p>
            <ConfirmDisputeButtons lang={lang} fieldKey="payment" />
          </div>
        )}
        {isAnswered("update_tags") ? (
          <AnsweredStub lang={lang} report={reportByKind.get("update_tags")!} />
        ) : (
          <AmenitiesGroup lang={lang} kioskId={kiosk.id} present={new Set(kiosk.tags)} />
        )}
        {(kiosk.tags?.length ?? 0) > 0 && (
          <div
            data-confirm-block
            data-field-key="tags"
            class="space-y-2 border-2 border-border-hi bg-surface-2 p-4"
          >
            <p class="text-sm text-fg-muted">{t(lang, "checkin.tagsOk")}</p>
            <p class="font-mono text-sm text-fg">
              {kiosk.tags!.map((slug) => tagLabel(lang, slug)).join(" · ")}
            </p>
            <ConfirmDisputeButtons lang={lang} fieldKey="tags" />
          </div>
        )}
        {isAnswered("wrong_name") ? (
          <AnsweredStub lang={lang} report={reportByKind.get("wrong_name")!} />
        ) : (
          <NameGroup lang={lang} kioskId={kiosk.id} currentName={kiosk.name} />
        )}
      </div>
    </div>
  );
};

const AnsweredStub: FC<{ lang: Lang; report: UserKioskReport }> = ({ lang, report }) => (
  <p class="border-2 border-border bg-bg p-4 text-sm text-fg-muted">
    <span class="font-display text-xs tracking-wider uppercase text-fg-dim">
      {kindLabel(lang, report.kind)} —{" "}
    </span>
    <span>{statusLabel(lang, report.status)}</span>. {t(lang, "checkin.thanks")}
  </p>
);

// ── group components ─────────────────────────────────────────────────────────

const groupCls = "border-2 border-border bg-bg p-4 space-y-3";
const labelCls = "block font-display text-xs tracking-wider uppercase text-fg-muted";
const inputCls =
  "w-full border-2 border-border bg-surface px-2 py-1 text-sm text-fg placeholder:text-fg-dim focus:border-neon-cyan focus:outline-none";

const submitCls =
  "cursor-pointer border-2 border-neon-cyan bg-transparent px-3 py-1 text-xs font-bold uppercase tracking-wider text-neon-cyan transition-colors hover:bg-neon-cyan hover:text-bg";

// Forms are intercepted by client/checkin.ts (data-checkin-form marker) —
// posted via fetch and replaced in-place with the response body. Falls back
// to a normal POST + redirect if JS is off.
const formAttrs = {
  method: "post" as const,
  action: "/api/reports",
  "data-checkin-form": "1",
};

const HoursGroup: FC<{ lang: Lang; kioskId: string }> = ({ lang, kioskId }) => (
  <form {...formAttrs} class={groupCls}>
    <input type="hidden" name="kiosk_id" value={kioskId} />
    <input type="hidden" name="kind" value="wrong_hours" />
    <span class={labelCls}>{t(lang, "checkin.hoursQ")}</span>
    <input
      type="text"
      name="new_hours"
      placeholder="z.B. Mo-Sa 07:00-22:00; Su 09:00-20:00"
      class={`font-mono ${inputCls}`}
      maxLength={200}
      required
    />
    <button type="submit" class={submitCls}>
      {t(lang, "checkin.send")}
    </button>
  </form>
);

const PaymentGroup: FC<{ lang: Lang; kioskId: string; missing: readonly string[] }> = ({
  lang,
  kioskId,
  missing,
}) => (
  <form {...formAttrs} class={groupCls}>
    <input type="hidden" name="kiosk_id" value={kioskId} />
    <input type="hidden" name="kind" value="update_payment" />
    <span class={labelCls}>{t(lang, "checkin.paymentQ")}</span>
    <div class="space-y-2">
      {missing.map((key) => {
        const icon = PAYMENT_ICONS[key];
        if (!icon) return null;
        return (
          <fieldset class="flex flex-wrap items-center gap-2">
            <legend class="mr-2 inline-flex items-center gap-1.5 text-sm text-fg">
              <span aria-hidden="true">{icon}</span>
              {PAYMENT_LABELS[lang][key] ?? key}
            </legend>
            <TriRadio name={`pay_${key}`} value="yes" label={t(lang, "radio.yes")} />
            <TriRadio name={`pay_${key}`} value="no" label={t(lang, "radio.no")} />
            <TriRadio
              name={`pay_${key}`}
              value=""
              label={t(lang, "radio.unknown")}
              checked
              tone="neutral"
            />
          </fieldset>
        );
      })}
    </div>
    <button type="submit" class={submitCls}>
      {t(lang, "checkin.send")}
    </button>
  </form>
);

const AmenitiesGroup: FC<{ lang: Lang; kioskId: string; present: Set<string> }> = ({
  lang,
  kioskId,
  present,
}) => (
  <form {...formAttrs} class={groupCls}>
    <input type="hidden" name="kiosk_id" value={kioskId} />
    <input type="hidden" name="kind" value="update_tags" />
    <span class={labelCls}>{t(lang, "checkin.amenitiesQ")}</span>
    {REPORTABLE_TAG_GROUPS.map((group) => (
      <div class="space-y-2">
        <p class="font-display text-[0.7rem] tracking-wider uppercase text-fg-dim">
          {tagGroupLabel(lang, group.label)}
        </p>
        {group.tags.map((slug) => (
          <fieldset class="flex flex-wrap items-center gap-2">
            <legend class="mr-2 inline-flex items-center gap-1.5 text-sm text-fg">
              <span aria-hidden="true">{TAG_ICONS[slug] ?? "•"}</span>
              {tagLabel(lang, slug)}
            </legend>
            <TriRadio
              name={`tag_${slug}`}
              value="yes"
              label={t(lang, "radio.yes")}
              checked={present.has(slug)}
            />
            <TriRadio name={`tag_${slug}`} value="no" label={t(lang, "radio.no")} />
            <TriRadio
              name={`tag_${slug}`}
              value=""
              label={t(lang, "radio.unknown")}
              checked={!present.has(slug)}
              tone="neutral"
            />
          </fieldset>
        ))}
      </div>
    ))}
    <button type="submit" class={submitCls}>
      {t(lang, "checkin.send")}
    </button>
  </form>
);

const NameGroup: FC<{ lang: Lang; kioskId: string; currentName: string }> = ({
  lang,
  kioskId,
  currentName,
}) => (
  <details class="border-2 border-border bg-bg">
    <summary class="cursor-pointer px-4 py-3 text-sm text-fg-dim hover:text-fg">
      {t(lang, "checkin.nameToggle")}
    </summary>
    <form {...formAttrs} class="space-y-3 p-4 pt-0">
      <input type="hidden" name="kiosk_id" value={kioskId} />
      <input type="hidden" name="kind" value="wrong_name" />
      <span class={labelCls}>{t(lang, "checkin.nameLabel")}</span>
      <input
        type="text"
        name="new_name"
        placeholder={currentName}
        class={inputCls}
        maxLength={120}
        required
      />
      <button type="submit" class={submitCls}>
        {t(lang, "checkin.send")}
      </button>
    </form>
  </details>
);

// ── primitives ───────────────────────────────────────────────────────────────

// `tone` softens the selected style for the neutral "Weiß nicht" option so a
// formful of unanswered defaults doesn't read as a wall of pink — only an
// affirmative Ja/Nein (or a pre-filled tag) lights up neon.
const TONE_CHECKED = {
  affirmative: "has-checked:border-neon-pink has-checked:bg-neon-pink has-checked:text-bg",
  neutral: "has-checked:border-fg-dim has-checked:bg-surface-2 has-checked:text-fg",
} as const;

const TriRadio: FC<{
  name: string;
  value: string;
  label: string;
  checked?: boolean;
  tone?: keyof typeof TONE_CHECKED;
}> = ({ name, value, label, checked, tone = "affirmative" }) => (
  <label
    class={`inline-flex cursor-pointer select-none items-center gap-1 border-2 border-border bg-surface px-2 py-1 text-xs font-medium text-fg-dim transition-colors hover:border-border-hi hover:text-fg ${TONE_CHECKED[tone]}`}
  >
    <input type="radio" name={name} value={value} checked={checked} class="peer sr-only" />
    <span>{label}</span>
  </label>
);
