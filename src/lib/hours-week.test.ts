import { describe, expect, it } from "bun:test";
import OpeningHours from "opening_hours";
import { isFlattenable, stateFromWeek, WEEK_MINUTES, weekMinute } from "./hours-week";
import { computeStatus } from "./opening-hours";

const MINUTE_MS = 60_000;
const WEEK_START = new Date("2024-01-15T00:00:00.000Z"); // Monday
const WEEK_END = new Date("2024-01-22T00:00:00.000Z");

/** The build step's flattening (scripts/import-data.ts), duplicated here so the
 *  tests can assert the encoding and the reader agree without a build. */
function flatten(raw: string): number[] {
  const intervals = new OpeningHours(raw, null).getOpenIntervals(
    WEEK_START,
    WEEK_END,
  ) as unknown as Array<[Date, Date]>;
  return intervals.flatMap(([start, end]) => [
    Math.round((start.getTime() - WEEK_START.getTime()) / MINUTE_MS),
    Math.round((end.getTime() - WEEK_START.getTime()) / MINUTE_MS),
  ]);
}

describe("weekMinute", () => {
  it("puts Monday 00:00 at zero and counts UTC minutes from there", () => {
    expect(weekMinute(new Date("2024-01-15T00:00:00Z"))).toBe(0);
    expect(weekMinute(new Date("2024-01-15T09:30:00Z"))).toBe(570);
  });

  it("treats Sunday as the last day, not the first", () => {
    // A JS-Date-derived getUTCDay() of 0 must map to day index 6, or every
    // Sunday reads as Monday's schedule.
    expect(weekMinute(new Date("2024-01-21T00:00:00Z"))).toBe(6 * 1440);
    expect(weekMinute(new Date("2024-01-21T23:59:00Z"))).toBe(WEEK_MINUTES - 1);
  });
});

describe("stateFromWeek", () => {
  it("reports closed with no next change when the schedule is empty", () => {
    expect(stateFromWeek([], 500)).toEqual({ open: false, until: null });
  });

  it("reports permanently open for a full-week span (24/7)", () => {
    expect(stateFromWeek(flatten("24/7"), 5000)).toEqual({ open: true, until: null });
  });

  it("counts minutes to the upcoming boundary in both states", () => {
    const week = flatten("Mo 09:00-17:00");
    expect(stateFromWeek(week, 8 * 60)).toEqual({ open: false, until: 60 });
    expect(stateFromWeek(week, 10 * 60)).toEqual({ open: true, until: 7 * 60 });
  });

  it("is open on the opening boundary and closed on the closing one", () => {
    const week = flatten("Mo 09:00-17:00");
    expect(stateFromWeek(week, 9 * 60).open).toBe(true);
    expect(stateFromWeek(week, 17 * 60).open).toBe(false);
  });

  it("wraps to next week when no boundary remains", () => {
    const week = flatten("Mo 09:00-17:00");
    // Sunday 23:00 — the next change is Monday 09:00, ten hours away.
    expect(stateFromWeek(week, 6 * 1440 + 23 * 60)).toEqual({ open: false, until: 600 });
  });

  it("treats a span crossing Sunday midnight as continuous", () => {
    // Stored truncated at WEEK_MINUTES and re-entering at 0. Sunday 23:30 must
    // stay open and point at Monday 01:00, not report a change at midnight.
    const week = flatten("Mo-Su 09:00-01:00");
    const sundayLate = stateFromWeek(week, 6 * 1440 + 23 * 60 + 30);
    expect(sundayLate.open).toBe(true);
    expect(sundayLate.until).toBe(90);
  });
});

describe("isFlattenable", () => {
  it("accepts plain weekly recurrences", () => {
    expect(isFlattenable("Mo-Sa 06:00-22:00")).toBe(true);
    expect(isFlattenable("24/7")).toBe(true);
  });

  it("rejects rules whose evaluation depends on the calendar date", () => {
    // Each of these would otherwise be baked into a week that is wrong on some
    // dates: holidays move, solar times drift, month ranges gate the whole rule.
    expect(isFlattenable("Mo-Sa 06:00-22:00; PH off")).toBe(false);
    expect(isFlattenable("Mo-Fr 08:00-sunset")).toBe(false);
    expect(isFlattenable("Mar-Oct 10:00-20:00")).toBe(false);
    expect(isFlattenable("Sa[1] 10:00-14:00")).toBe(false);
    expect(isFlattenable("2026 Mo-Fr 09:00-17:00")).toBe(false);
    expect(isFlattenable("SH Mo-Fr 09:00-17:00")).toBe(false);
  });

  it("rejects forms whose flattening disagrees with the library", () => {
    // getOpenIntervals reports a span for all three; getState does not agree,
    // so baking them would flip the answer.
    expect(isFlattenable("Fr 17:00+")).toBe(false);
    expect(isFlattenable("Mo-Fr 09:00-17:00; Sa unknown")).toBe(false);
    expect(isFlattenable('"nach Bedarf"')).toBe(false);
  });
});

describe("computeStatus flattened path", () => {
  const RULES = [
    "Mo-Sa 06:00-22:00",
    "24/7",
    "Mo-Fr 09:00-17:00; Sa 10:00-14:00",
    "Mo-Su 09:00-01:00",
    "Tu-Su 11:00-23:00",
    "Mo-Fr 06:00-09:00,15:00-19:00",
  ];

  it("agrees with opening_hours.js on state and next change, hour by hour", () => {
    for (const raw of RULES) {
      const week = flatten(raw);
      const oh = new OpeningHours(raw, null);
      for (let day = 0; day < 7; day++) {
        for (const hour of [0, 1, 6, 9, 12, 17, 22, 23]) {
          const now = new Date(Date.UTC(2026, 7, 17 + day, hour, 31, 0));
          const fast = computeStatus({ raw, week }, now);
          const slow = computeStatus({ raw }, now);
          expect(fast.kind, `${raw} @ ${now.toISOString()}`).toBe(slow.kind);
          expect(oh.getState(now)).toBe(fast.kind === "open");
          if (fast.kind !== "unknown" && fast.until && slow.kind !== "unknown" && slow.until) {
            expect(fast.until.getTime(), `${raw} @ ${now.toISOString()}`).toBe(
              slow.until.getTime(),
            );
          }
        }
      }
    }
  });

  it("falls back to the library when no week was baked", () => {
    // A PH rule never gets a `week`, so location-aware evaluation must survive.
    const hours = { raw: "Mo-Sa 06:00-22:00; PH off" };
    expect(computeStatus(hours, new Date("2026-09-26T12:00:00Z")).kind).toBe("open");
  });

  it("reports unknown when there are no hours at all", () => {
    expect(computeStatus(undefined).kind).toBe("unknown");
    expect(computeStatus({}).kind).toBe("unknown");
  });
});
