/**
 * Wraps the `opening_hours` library to compute the current status of a kiosk.
 *
 * `opening_hours.js` understands the OSM textual format (`Mo-Fr 09:00-22:00`),
 * which is what we store in `kiosks.hours_raw`. We catch parse errors and
 * gracefully degrade — bad upstream data shouldn't 500 the detail page.
 */

import OpeningHours from "opening_hours";

export type Status =
  | { kind: "open"; until: Date | null }
  | { kind: "closed"; until: Date | null }
  | { kind: "unknown" };

export function computeStatus(raw: string | null | undefined, now = new Date()): Status {
  if (!raw) return { kind: "unknown" };
  try {
    const oh = new OpeningHours(raw);
    const open = oh.getState(now);
    const next = oh.getNextChange(now);
    return open ? { kind: "open", until: next ?? null } : { kind: "closed", until: next ?? null };
  } catch {
    return { kind: "unknown" };
  }
}

export function formatStatus(s: Status, locale = "de-DE"): string {
  if (s.kind === "unknown") return "Öffnungszeiten unbekannt";
  const time = s.until
    ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(s.until)
    : null;
  if (s.kind === "open") return time ? `Offen bis ${time}` : "Offen";
  return time ? `Geschlossen — öffnet ${time}` : "Geschlossen";
}
