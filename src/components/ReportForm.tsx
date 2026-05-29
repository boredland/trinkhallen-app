import type { FC } from "hono/jsx";
import type { Lang } from "../lib/messages";
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

const KINDS: Array<{ value: string; label: string }> = [
  { value: "wrong_hours", label: "Falsche Öffnungszeiten" },
  { value: "wrong_address", label: "Falsche Adresse" },
  { value: "closed", label: "Dauerhaft geschlossen" },
  { value: "duplicate", label: "Doppelter Eintrag" },
  { value: "other", label: "Sonstiges" },
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
        <a href="/me" class="text-neon-cyan underline-offset-2 hover:underline">
          Anmelden
        </a>{" "}
        und uns auf einen Fehler in den Daten hinweisen.
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
        <p class="text-sm text-fg-muted">
          Du hast bereits zu allen Kategorien etwas gemeldet — danke!
        </p>
      ) : (
        <details class="text-sm">
          <summary class="cursor-pointer font-display tracking-wider uppercase text-fg-muted hover:text-neon-pink">
            Falsche oder fehlende Info melden
          </summary>
          <form action="/api/reports" method="post" class="mt-4 space-y-3">
            <input type="hidden" name="kiosk_id" value={kioskId} />

            <label class="block">
              <span class="block text-xs uppercase tracking-wider text-fg-dim">
                Was stimmt nicht?
              </span>
              <select
                name="kind"
                required
                class="mt-1 w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
              >
                {availableKinds.map((k) => (
                  <option value={k.value}>{k.label}</option>
                ))}
              </select>
            </label>

            <fieldset class="hidden space-y-2" data-kind="wrong_hours">
              <legend class="block text-xs uppercase tracking-wider text-fg-dim">
                Richtige Zeiten
              </legend>
              <input
                type="text"
                name="new_hours"
                placeholder={currentHoursRaw ?? "z. B. Mo-Fr 09:00-22:00; Sa 10:00-20:00"}
                class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 font-mono text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
              />
              <p class="text-xs text-fg-dim">
                OSM <code>opening_hours</code>-Format.
              </p>
            </fieldset>

            <fieldset class="hidden space-y-2" data-kind="wrong_address">
              <legend class="block text-xs uppercase tracking-wider text-fg-dim">
                Korrekte Adresse
              </legend>
              <input
                type="text"
                name="new_street"
                placeholder="Straße"
                class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
              />
              <div class="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  name="new_number"
                  placeholder="Nr"
                  class="border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
                />
                <input
                  type="text"
                  name="new_postalcode"
                  placeholder="PLZ"
                  maxLength={5}
                  class="border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
                />
              </div>
              <input
                type="text"
                name="new_city"
                placeholder="Stadt"
                class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none"
              />
            </fieldset>

            <label class="block">
              <span class="block text-xs uppercase tracking-wider text-fg-dim">
                Notiz (optional)
              </span>
              <textarea
                name="note"
                rows={2}
                maxLength={500}
                placeholder="Was sollte sich ändern?"
                class="mt-1 w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
              />
            </label>

            <button type="submit" class="btn-neon">
              ▶ Melden
            </button>
            <p class="text-xs text-fg-dim">Wird von Moderator:innen geprüft.</p>
          </form>
        </details>
      )}
    </div>
  );
};

const SubmittedPanel: FC<{ lang: Lang; reports: UserKioskReport[] }> = ({ lang, reports }) => (
  <div class="border-2 border-border bg-surface-2 p-3 text-sm">
    <p class="mb-2 text-xs uppercase tracking-wider text-fg-dim">Du hast hier bereits gemeldet:</p>
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
