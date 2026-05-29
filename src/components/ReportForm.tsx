import type { FC } from "hono/jsx";
import { type Lang, type MessageKey, pathForLang, t } from "../lib/messages";
import { kindLabel, statusLabel, type UserKioskReport } from "../lib/reports";

export interface ReportFormProps {
  lang: Lang;
  kioskId: string;
  isLoggedIn: boolean;
  /** Optional: pre-fill hours text from the kiosk for the wrong_hours flow. */
  currentHoursRaw?: string;
  /** Reports this user already submitted for this kiosk that are still
   *  in flight or accepted. We drop their `kind` from the select and
   *  surface a "Bereits gemeldet" panel above the form. */
  userReports?: UserKioskReport[];
}

const KINDS: Array<{ value: string; labelKey: MessageKey }> = [
  { value: "wrong_hours", labelKey: "reportForm.kindWrongHours" },
  { value: "wrong_address", labelKey: "reportForm.kindWrongAddress" },
  { value: "closed", labelKey: "reportForm.kindClosed" },
  { value: "duplicate", labelKey: "reportForm.kindDuplicate" },
  { value: "other", labelKey: "reportForm.kindOther" },
];

/**
 * Collapsible report form on the kiosk detail page. The `kind` select toggles
 * which payload section is visible via the [data-kind] attribute on each
 * section, switched by a tiny script in app.entry.ts.
 */
export const ReportForm: FC<ReportFormProps> = ({
  lang,
  kioskId,
  isLoggedIn,
  currentHoursRaw,
  userReports = [],
}) => {
  if (!isLoggedIn) {
    return (
      <p class="text-sm text-fg-muted">
        <a href={pathForLang("/me", lang)} class="text-neon-cyan underline underline-offset-2">
          {t(lang, "auth.login")}
        </a>{" "}
        {t(lang, "reportForm.loginHint")}
      </p>
    );
  }

  const submittedKinds = new Set(userReports.map((r) => r.kind));
  const availableKinds = KINDS.filter((k) => !submittedKinds.has(k.value));
  const exhausted = availableKinds.length === 0;

  return (
    <div class="space-y-3" data-report-form>
      {userReports.length > 0 && <SubmittedPanel lang={lang} reports={userReports} />}
      {exhausted ? (
        <p class="text-sm text-fg-muted">{t(lang, "reportForm.allReported")}</p>
      ) : (
        <details class="text-sm">
          <summary class="cursor-pointer font-display tracking-wider uppercase text-fg-muted hover:text-neon-pink">
            {t(lang, "reportForm.toggle")}
          </summary>
          <form action="/api/reports" method="post" class="mt-4 space-y-3">
            <input type="hidden" name="kiosk_id" value={kioskId} />

            <label class="block">
              <span class="block text-xs uppercase tracking-wider text-fg-dim">
                {t(lang, "reportForm.whatsWrong")}
              </span>
              <select
                name="kind"
                required
                class="mt-1 w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
              >
                {availableKinds.map((k) => (
                  <option value={k.value}>{t(lang, k.labelKey)}</option>
                ))}
              </select>
            </label>

            <fieldset class="hidden space-y-2" data-kind="wrong_hours">
              <legend class="block text-xs uppercase tracking-wider text-fg-dim">
                {t(lang, "reportForm.correctTimes")}
              </legend>
              <input
                type="text"
                name="new_hours"
                placeholder={currentHoursRaw ?? "z. B. Mo-Fr 09:00-22:00; Sa 10:00-20:00"}
                class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 font-mono text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
              />
              <p class="text-xs text-fg-dim">
                {t(lang, "reportForm.osmFormatPre")}
                <code>opening_hours</code>
                {t(lang, "reportForm.osmFormatPost")}
              </p>
            </fieldset>

            <fieldset class="hidden space-y-2" data-kind="wrong_address">
              <legend class="block text-xs uppercase tracking-wider text-fg-dim">
                {t(lang, "reportForm.correctAddress")}
              </legend>
              <input
                type="text"
                name="new_street"
                placeholder={t(lang, "reportForm.street")}
                class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
              />
              <div class="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  name="new_number"
                  placeholder={t(lang, "reportForm.number")}
                  class="border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
                />
                <input
                  type="text"
                  name="new_postalcode"
                  placeholder={t(lang, "reportForm.postalcode")}
                  maxLength={5}
                  class="border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
                />
              </div>
              <input
                type="text"
                name="new_city"
                placeholder={t(lang, "reportForm.city")}
                class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
              />
            </fieldset>

            <label class="block">
              <span class="block text-xs uppercase tracking-wider text-fg-dim">
                {t(lang, "reportForm.noteOptional")}
              </span>
              <textarea
                name="note"
                rows={2}
                maxLength={500}
                placeholder={t(lang, "reportForm.notePlaceholder")}
                class="mt-1 w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
              />
            </label>

            <button type="submit" class="btn-neon">
              {t(lang, "reportForm.submit")}
            </button>
            <p class="text-xs text-fg-dim">{t(lang, "reportForm.moderated")}</p>
          </form>
        </details>
      )}
    </div>
  );
};

const SubmittedPanel: FC<{ lang: Lang; reports: UserKioskReport[] }> = ({ lang, reports }) => (
  <div class="border-2 border-border bg-surface-2 p-3 text-sm">
    <p class="mb-2 text-xs uppercase tracking-wider text-fg-dim">
      {t(lang, "reportForm.alreadyReported")}
    </p>
    <ul class="space-y-1">
      {reports.map((r) => (
        <li class="flex items-center justify-between gap-2">
          <span class="text-fg">{kindLabel(lang, r.kind)}</span>
          <span class="font-display text-xs tracking-wider uppercase text-fg-muted">
            {statusLabel(lang, r.status)}
          </span>
        </li>
      ))}
    </ul>
  </div>
);
