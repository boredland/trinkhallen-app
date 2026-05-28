import type { FC } from "hono/jsx";
import type { KioskRecord } from "../lib/db";
import { kindLabel, statusLabel, type UserKioskReport } from "../lib/reports";
import { REPORTABLE_TAG_GROUPS, tagLabel } from "../lib/tags";

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

const PAYMENT_LABELS: Record<string, { de: string; icon: string }> = {
  cards: { de: "Karte", icon: "💳" },
  contactless: { de: "Kontaktlos", icon: "📲" },
  girocard: { de: "Girocard", icon: "🟦" },
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
const ConfirmDisputeButtons: FC<{ fieldKey: string }> = ({ fieldKey }) => (
  <div class="flex flex-wrap gap-2">
    <button
      type="button"
      data-signal-confirm
      data-field-key={fieldKey}
      class="inline-flex cursor-pointer items-center gap-2 border-2 border-neon-cyan px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-neon-cyan hover:bg-neon-cyan hover:text-bg disabled:opacity-60"
    >
      <span aria-hidden="true">✓</span>
      Passt — bestätigen
    </button>
    <button
      type="button"
      data-signal-dispute
      data-field-key={fieldKey}
      class="inline-flex cursor-pointer items-center gap-2 border-2 border-border-hi px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-fg-muted hover:border-danger hover:text-danger disabled:opacity-60"
    >
      <span aria-hidden="true">✕</span>
      Stimmt nicht
    </button>
  </div>
);

export const CheckinForm: FC<{
  kiosk: KioskRecord;
  isLoggedIn: boolean;
  userReports?: UserKioskReport[];
}> = ({ kiosk, isLoggedIn, userReports = [] }) => {
  if (!isLoggedIn) {
    return (
      <p class="text-sm text-fg-muted">
        <a href="/me" class="text-neon-cyan underline-offset-2 hover:underline">
          Anmelden
        </a>
        , um deinen Besuch festzuhalten und Daten zu ergänzen.
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
        Ich war hier
      </button>

      <div data-checkin-questions hidden class="space-y-5">
        <p class="text-sm text-fg-dim">
          Was hat gefehlt? Jede Antwort hilft. Du kannst auch nichts angeben.
        </p>

        {hoursMissing &&
          (isAnswered("wrong_hours") ? (
            <AnsweredStub report={reportByKind.get("wrong_hours")!} />
          ) : (
            <HoursGroup kioskId={kiosk.id} />
          ))}
        {kiosk.hours?.raw && (
          <div
            data-confirm-block
            data-field-key="opening_hours"
            class="space-y-2 border-2 border-border-hi bg-surface-2 p-4"
          >
            <p class="text-sm text-fg-muted">Stimmen die Öffnungszeiten?</p>
            <p class="font-mono text-sm text-fg">{kiosk.hours.raw}</p>
            <ConfirmDisputeButtons fieldKey="opening_hours" />
          </div>
        )}
        {missingPayment.length > 0 &&
          (isAnswered("update_payment") ? (
            <AnsweredStub report={reportByKind.get("update_payment")!} />
          ) : (
            <PaymentGroup kioskId={kiosk.id} missing={missingPayment} />
          ))}
        {settledPayment.length > 0 && (
          <div
            data-confirm-block
            data-field-key="payment"
            class="space-y-2 border-2 border-border-hi bg-surface-2 p-4"
          >
            <p class="text-sm text-fg-muted">Stimmen die Zahlungsoptionen?</p>
            <p class="font-mono text-sm text-fg">
              {settledPayment
                .map(
                  (k) =>
                    `${PAYMENT_LABELS[k]?.de ?? k}: ${kiosk.payment?.[k] === "yes" ? "ja" : "nein"}`,
                )
                .join(" · ")}
            </p>
            <ConfirmDisputeButtons fieldKey="payment" />
          </div>
        )}
        {isAnswered("update_tags") ? (
          <AnsweredStub report={reportByKind.get("update_tags")!} />
        ) : (
          <AmenitiesGroup kioskId={kiosk.id} present={new Set(kiosk.tags)} />
        )}
        {(kiosk.tags?.length ?? 0) > 0 && (
          <div
            data-confirm-block
            data-field-key="tags"
            class="space-y-2 border-2 border-border-hi bg-surface-2 p-4"
          >
            <p class="text-sm text-fg-muted">Stimmen die hinterlegten Tags?</p>
            <p class="font-mono text-sm text-fg">
              {kiosk.tags!.map((t) => tagLabel(t)).join(" · ")}
            </p>
            <ConfirmDisputeButtons fieldKey="tags" />
          </div>
        )}
        {isAnswered("wrong_name") ? (
          <AnsweredStub report={reportByKind.get("wrong_name")!} />
        ) : (
          <NameGroup kioskId={kiosk.id} currentName={kiosk.name} />
        )}
      </div>
    </div>
  );
};

const AnsweredStub: FC<{ report: UserKioskReport }> = ({ report }) => (
  <p class="border-2 border-border bg-bg p-4 text-sm text-fg-muted">
    <span class="font-display text-xs tracking-wider uppercase text-fg-dim">
      {kindLabel(report.kind)} —{" "}
    </span>
    <span>{statusLabel(report.status)}</span>. Danke!
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

const HoursGroup: FC<{ kioskId: string }> = ({ kioskId }) => (
  <form {...formAttrs} class={groupCls}>
    <input type="hidden" name="kiosk_id" value={kioskId} />
    <input type="hidden" name="kind" value="wrong_hours" />
    <span class={labelCls}>Öffnungszeiten?</span>
    <input
      type="text"
      name="new_hours"
      placeholder="z.B. Mo-Sa 07:00-22:00; Su 09:00-20:00"
      class={`font-mono ${inputCls}`}
      maxLength={200}
      required
    />
    <button type="submit" class={submitCls}>
      Senden
    </button>
  </form>
);

const PaymentGroup: FC<{ kioskId: string; missing: readonly string[] }> = ({
  kioskId,
  missing,
}) => (
  <form {...formAttrs} class={groupCls}>
    <input type="hidden" name="kiosk_id" value={kioskId} />
    <input type="hidden" name="kind" value="update_payment" />
    <span class={labelCls}>Zahlung möglich?</span>
    <div class="space-y-2">
      {missing.map((key) => {
        const info = PAYMENT_LABELS[key];
        if (!info) return null;
        return (
          <fieldset class="flex flex-wrap items-center gap-2">
            <legend class="mr-2 inline-flex items-center gap-1.5 text-sm text-fg">
              <span aria-hidden="true">{info.icon}</span>
              {info.de}
            </legend>
            <TriRadio name={`pay_${key}`} value="yes" label="Ja" />
            <TriRadio name={`pay_${key}`} value="no" label="Nein" />
            <TriRadio name={`pay_${key}`} value="" label="Weiß nicht" checked tone="neutral" />
          </fieldset>
        );
      })}
    </div>
    <button type="submit" class={submitCls}>
      Senden
    </button>
  </form>
);

const AmenitiesGroup: FC<{ kioskId: string; present: Set<string> }> = ({ kioskId, present }) => (
  <form {...formAttrs} class={groupCls}>
    <input type="hidden" name="kiosk_id" value={kioskId} />
    <input type="hidden" name="kind" value="update_tags" />
    <span class={labelCls}>Was gibt's hier?</span>
    {REPORTABLE_TAG_GROUPS.map((group) => (
      <div class="space-y-2">
        <p class="font-display text-[0.7rem] tracking-wider uppercase text-fg-dim">{group.label}</p>
        {group.tags.map((slug) => (
          <fieldset class="flex flex-wrap items-center gap-2">
            <legend class="mr-2 inline-flex items-center gap-1.5 text-sm text-fg">
              <span aria-hidden="true">{TAG_ICONS[slug] ?? "•"}</span>
              {tagLabel(slug)}
            </legend>
            <TriRadio name={`tag_${slug}`} value="yes" label="Ja" checked={present.has(slug)} />
            <TriRadio name={`tag_${slug}`} value="no" label="Nein" />
            <TriRadio
              name={`tag_${slug}`}
              value=""
              label="Weiß nicht"
              checked={!present.has(slug)}
              tone="neutral"
            />
          </fieldset>
        ))}
      </div>
    ))}
    <button type="submit" class={submitCls}>
      Senden
    </button>
  </form>
);

const NameGroup: FC<{ kioskId: string; currentName: string }> = ({ kioskId, currentName }) => (
  <details class="border-2 border-border bg-bg">
    <summary class="cursor-pointer px-4 py-3 text-sm text-fg-dim hover:text-fg">
      Heißt eigentlich anders?
    </summary>
    <form {...formAttrs} class="space-y-3 p-4 pt-0">
      <input type="hidden" name="kiosk_id" value={kioskId} />
      <input type="hidden" name="kind" value="wrong_name" />
      <span class={labelCls}>Richtiger Name</span>
      <input
        type="text"
        name="new_name"
        placeholder={currentName}
        class={inputCls}
        maxLength={120}
        required
      />
      <button type="submit" class={submitCls}>
        Senden
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
