/**
 * Pre-flattened weekly opening schedules.
 *
 * `opening_hours.js` costs ~45 µs per kiosk to instantiate and evaluate, which
 * dominated Worker CPU on every collection view: the map panel and the city
 * pages ask "is this open right now?" for every kiosk in the bbox. 88 % of the
 * dataset's rules are plain weekly recurrences, so `scripts/import-data.ts`
 * bakes those into a flat array of minute offsets and the runtime answers with
 * a binary search instead of a parse.
 *
 * Encoding: alternating open/close boundaries, minutes since Monday 00:00,
 * strictly ascending. An odd insertion index therefore means "inside an open
 * span". A span crossing Sunday midnight is stored truncated at `WEEK_MINUTES`
 * and re-entering at 0.
 *
 * UTC throughout. Workers run in UTC and `opening_hours.js` reads OSM
 * wall-clock times as local, so the two coincide — the same assumption
 * `formatHoursTable` already documents.
 */

export const WEEK_MINUTES = 7 * 24 * 60;

/** Rules whose evaluation depends on the calendar date, or whose parse the
 *  flattening cannot reproduce faithfully. Each was found by diffing
 *  `getOpenIntervals` against `getState` across the dataset:
 *
 *    - solar times, nth-weekday selectors, explicit years, public and school
 *      holidays, month ranges → the week is not the whole story
 *    - open-end (`17:00+`) → `getOpenIntervals` reports a span, `getState`
 *      does not consider it open
 *    - `unknown` → an interval is reported for an explicitly unknown state
 *    - a quoted comment (`"nach Bedarf"`) → reported as open all week
 */
const NOT_FLATTENABLE =
  /sunrise|sunset|dawn|dusk|\[[-0-9]+\]|\b20\d\d\b|(^|[\s,;])(PH|SH)(\b|,)|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\+|"|unknown/i;

export function isFlattenable(raw: string): boolean {
  return !NOT_FLATTENABLE.test(raw);
}

/** Minute-of-week for `now`, Monday 00:00 = 0. */
export function weekMinute(now: Date): number {
  return ((now.getUTCDay() + 6) % 7) * 1440 + now.getUTCHours() * 60 + now.getUTCMinutes();
}

export interface WeekState {
  open: boolean;
  /** Minutes until the next open/close transition, or null when the schedule
   *  never changes (always open, or never open). */
  until: number | null;
}

export function stateFromWeek(week: readonly number[], minute: number): WeekState {
  if (week.length === 0) return { open: false, until: null };

  // A leading 0 paired with a trailing WEEK_MINUTES is one span stitched
  // across Sunday midnight, not two separate transitions.
  const wrapsAround = week[0] === 0 && week[week.length - 1] === WEEK_MINUTES;
  if (wrapsAround && week.length === 2) return { open: true, until: null };

  let lo = 0;
  let hi = week.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (week[mid]! <= minute) lo = mid + 1;
    else hi = mid;
  }

  const next = lo < week.length ? week[lo]! : week[0]! + WEEK_MINUTES;
  // Landing on the wrap seam is not a transition — the span continues, so the
  // next real change is the boundary after it.
  const boundary = wrapsAround && next % WEEK_MINUTES === 0 ? week[1]! + WEEK_MINUTES : next;
  return {
    open: (lo & 1) === 1,
    until: (((boundary - minute) % WEEK_MINUTES) + WEEK_MINUTES) % WEEK_MINUTES,
  };
}
