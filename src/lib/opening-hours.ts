/**
 * Wraps the `opening_hours` library to compute the current status of a kiosk.
 *
 * `opening_hours.js` understands the OSM textual format (`Mo-Fr 09:00-22:00`),
 * which is what we store in `kiosks.hours_raw`. We catch parse errors and
 * gracefully degrade — bad upstream data shouldn't 500 the detail page.
 */

import OpeningHours, { type nominatim_object } from "opening_hours";
import type { KioskRecord } from "./db";
import { getBundeslandForRegion } from "./regions";

export type Status =
  | { kind: "open"; until: Date | null }
  | { kind: "closed"; until: Date | null }
  | { kind: "unknown" };

/**
 * Location context for `PH` (public holiday) resolution. Without it,
 * `opening_hours.js` cannot decide whether today is a Bundesland holiday
 * and rules like `Mo-Fr 06:00-22:00; PH off` either throw or
 * mis-evaluate. `state` is the full German state name (e.g. "Hessen");
 * see `getBundeslandForRegion` in lib/regions.ts.
 */
export interface OpeningHoursLocation {
  lat: number;
  lon: number;
  state: string;
}

function buildNominatim(loc: OpeningHoursLocation | undefined): nominatim_object | null {
  if (!loc) return null;
  return {
    lat: loc.lat,
    lon: loc.lon,
    address: { country_code: "de", state: loc.state },
  };
}

/**
 * Derives the location context for a kiosk so callers can pass a single
 * argument through to `computeStatus` / `formatHoursTable`. Returns
 * `undefined` when the region is unknown (data-repo addition we haven't
 * mirrored yet) — better to evaluate without state than with a wrong one.
 */
export function kioskLocation(
  kiosk: Pick<KioskRecord, "region" | "lat" | "lng">,
): OpeningHoursLocation | undefined {
  const state = getBundeslandForRegion(kiosk.region);
  if (!state) return undefined;
  return { lat: kiosk.lat, lon: kiosk.lng, state };
}

/**
 * Is the supplied date a public holiday for the kiosk's Bundesland?
 *
 * We instantiate a synthetic `PH`-only ruleset and ask `opening_hours.js`
 * whether the date matches — that pushes the holiday-DB lookup into the
 * library we already ship. Returns `false` when no location is available
 * (we'd rather under-flag than mis-flag).
 */
export function isPublicHolidayToday(
  location: OpeningHoursLocation | undefined,
  now = new Date(),
): boolean {
  const nominatim = buildNominatim(location);
  if (!nominatim) return false;
  try {
    return new OpeningHours("PH", nominatim).getState(now);
  } catch {
    return false;
  }
}

/**
 * True when the raw OSM string declares any rule scoped to `PH` (public
 * holidays) — either `PH off`, `PH 10:00-14:00`, or a multi-token rule
 * like `PH,Su …`. Used to decide whether to auto-file a PH observation
 * (we only do it for kiosks that *lack* PH info).
 */
export function hasPHToken(raw: string | null | undefined): boolean {
  if (!raw) return false;
  // Word-boundary match avoids false positives in arbitrary comments.
  return /(^|[\s,;])PH(\b|,)/.test(raw);
}

export function computeStatus(
  raw: string | null | undefined,
  now = new Date(),
  location?: OpeningHoursLocation,
): Status {
  if (!raw) return { kind: "unknown" };
  try {
    const oh = new OpeningHours(raw, buildNominatim(location));
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

/** German day-of-week abbreviations, Mon=0 … Sun=6. */
const DAY_LABELS_DE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

/**
 * Fixed reference week used for computing a canonical 7-day schedule.
 * Cloudflare Workers run in UTC, and opening_hours.js interprets times
 * as local (= UTC here), so the hour values match the OSM values directly.
 */
const WEEK_START = new Date("2024-01-15T00:00:00.000Z"); // Monday
const WEEK_END = new Date("2024-01-22T00:00:00.000Z"); // Following Monday
const DAY_MS = 24 * 60 * 60 * 1000;

function fmtUtcTime(d: Date): string {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Parses an OSM `opening_hours` string and returns a human-readable weekly
 * schedule as rows of German day labels + time ranges, suitable for display
 * in a definition list. Returns `null` when the string cannot be parsed.
 *
 * Example input:  `Mo-Fr 09:00-22:00; Sa 10:00-20:00`
 * Example output: `[{ days: "Mo–Fr", hours: "09:00–22:00" }, { days: "Sa", hours: "10:00–20:00" }, { days: "So", hours: "geschlossen" }]`
 */
export function formatHoursTable(
  raw: string | null | undefined,
  location?: OpeningHoursLocation,
): { days: string; hours: string }[] | null {
  if (!raw) return null;
  try {
    const oh = new OpeningHours(raw, buildNominatim(location));
    const intervals = oh.getOpenIntervals(WEEK_START, WEEK_END);

    // Collect per-day [start, end] ranges; Mon=0 … Sun=6.
    const daySlots: [string, string][][] = Array.from({ length: 7 }, () => []);

    for (const [start, end] of intervals) {
      // Split multi-day intervals (e.g. 24/7) into individual day portions.
      const startMs = Math.max(start.getTime(), WEEK_START.getTime());
      const endMs = Math.min(end.getTime(), WEEK_END.getTime());

      let cur = startMs;
      while (cur < endMs) {
        const dayOffset = Math.floor((cur - WEEK_START.getTime()) / DAY_MS);
        if (dayOffset < 0 || dayOffset >= 7) break;

        const dayStartMs = WEEK_START.getTime() + dayOffset * DAY_MS;
        const dayEndMs = dayStartMs + DAY_MS;

        const slotStart = new Date(Math.max(cur, dayStartMs));
        const slotEnd = new Date(Math.min(endMs, dayEndMs));

        // Show 24:00 when the slot ends at midnight of the next day.
        const endStr = slotEnd.getTime() === dayEndMs ? "24:00" : fmtUtcTime(slotEnd);
        // dayOffset is in [0,6] (checked above), so the element always exists.
        daySlots[dayOffset]!.push([fmtUtcTime(slotStart), endStr]);

        cur = dayEndMs;
      }
    }

    // Fold cross-midnight spillover back into the day it belongs to: a slot
    // ending at 24:00 whose continuation is the next day's leading "00:00–E"
    // reads far better as "S–E" (e.g. "08:00–00:30") than split into a
    // confusing "00:00–00:30" chunk on the following row. Cyclic — Sunday's
    // tail wraps onto Monday. Full days (00:00–24:00) and 24/7 are left as-is
    // so they don't collapse into each other.
    for (let d = 0; d < 7; d++) {
      const today = daySlots[d]!;
      const next = daySlots[(d + 1) % 7]!;
      const last = today.at(-1);
      const head = next[0];
      if (
        last &&
        head &&
        last[1] === "24:00" &&
        last[0] !== "00:00" &&
        head[0] === "00:00" &&
        head[1] !== "24:00"
      ) {
        last[1] = head[1];
        next.shift();
      }
    }

    const fmtSlots = (slots: [string, string][]): string =>
      slots.map(([s, e]) => `${s}–${e}`).join(", ");

    // Group consecutive days that share the exact same time ranges.
    const rows: { days: string; hours: string }[] = [];
    let i = 0;
    while (i < 7) {
      const hoursStr = fmtSlots(daySlots[i]!);
      let j = i + 1;
      while (j < 7 && fmtSlots(daySlots[j]!) === hoursStr) j++;

      const count = j - i;
      // i and j-1 are both in [0,6]; DAY_LABELS_DE has exactly 7 entries.
      const dayLabel =
        count >= 3
          ? `${DAY_LABELS_DE[i]!}–${DAY_LABELS_DE[j - 1]!}`
          : count === 2
            ? `${DAY_LABELS_DE[i]!}, ${DAY_LABELS_DE[j - 1]!}`
            : DAY_LABELS_DE[i]!;

      rows.push({ days: dayLabel, hours: hoursStr || "geschlossen" });
      i = j;
    }

    return rows;
  } catch {
    return null;
  }
}
