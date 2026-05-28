import { describe, expect, it } from "bun:test";
import { recordSignal } from "./signals";

// Frankfurt-ish; the exact spot doesn't matter, only that the user fix is
// consistently in/out of range across cases.
const KIOSK = { lat: 50.1109, lng: 8.6821 };
// ~430m east of the kiosk at this latitude — out of range with normal accuracy.
const FAR_OFFSET = 0.006;

interface FakeRun {
  sql: string;
  bound: unknown[];
}

function fakeDb(opts: { dedupe?: boolean } = {}): {
  env: { DB: D1Database };
  runs: FakeRun[];
} {
  const runs: FakeRun[] = [];
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...a: unknown[]) => {
        bound = a;
        return stmt;
      },
      first: () => Promise.resolve(null),
      run: () => {
        runs.push({ sql, bound });
        // INSERT OR IGNORE on a dedupe collision reports zero changes.
        return Promise.resolve({ meta: { changes: opts.dedupe ? 0 : 1 } });
      },
    };
    return stmt;
  };
  return { env: { DB: { prepare } as unknown as D1Database }, runs };
}

const baseInput = {
  kioskId: "tk_fr_001",
  kioskLat: KIOSK.lat,
  kioskLng: KIOSK.lng,
  regionSlug: "frankfurt",
  userId: "u-1",
  fieldKey: "opening_hours",
  action: "confirm" as const,
};

describe("recordSignal", () => {
  it("records a confirm at the kiosk", async () => {
    const { env, runs } = fakeDb();
    const r = await recordSignal(env as never, {
      ...baseInput,
      userLat: KIOSK.lat,
      userLng: KIOSK.lng,
      accuracy: 20,
    });
    expect(r).toMatchObject({ ok: true, inserted: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sql).toContain("INSERT OR IGNORE INTO field_signals");
    // confirm action ⇒ asserted_value is null
    expect(runs[0]!.bound[4]).toBeNull();
  });

  it("treats a same-day re-confirm as a silent dedup", async () => {
    const { env } = fakeDb({ dedupe: true });
    const r = await recordSignal(env as never, {
      ...baseInput,
      userLat: KIOSK.lat,
      userLng: KIOSK.lng,
      accuracy: 20,
    });
    expect(r).toMatchObject({ ok: true, inserted: false });
  });

  it("rejects without a fix as no_fix and does not write", async () => {
    const { env, runs } = fakeDb();
    const r = await recordSignal(env as never, { ...baseInput });
    expect(r).toEqual({ ok: false, reason: "no_fix" });
    expect(runs).toHaveLength(0);
  });

  it("rejects an out-of-range fix as out_of_range", async () => {
    const { env, runs } = fakeDb();
    const r = await recordSignal(env as never, {
      ...baseInput,
      userLat: KIOSK.lat,
      userLng: KIOSK.lng + FAR_OFFSET,
      accuracy: 20,
    });
    expect(r).toEqual({ ok: false, reason: "out_of_range" });
    expect(runs).toHaveLength(0);
  });

  it("rejects a wildly-noisy out-of-range fix as low_accuracy", async () => {
    const { env, runs } = fakeDb();
    const r = await recordSignal(env as never, {
      ...baseInput,
      userLat: KIOSK.lat,
      userLng: KIOSK.lng + FAR_OFFSET,
      accuracy: 5000,
    });
    expect(r).toEqual({ ok: false, reason: "low_accuracy" });
    expect(runs).toHaveLength(0);
  });

  it("persists asserted_value for fill, ignores it for confirm", async () => {
    const { env, runs } = fakeDb();
    await recordSignal(env as never, {
      ...baseInput,
      action: "fill",
      assertedValue: "Mo-Fr 06:00-22:00",
      userLat: KIOSK.lat,
      userLng: KIOSK.lng,
      accuracy: 10,
    });
    expect(runs[0]!.bound[4]).toBe("Mo-Fr 06:00-22:00");

    const { env: env2, runs: runs2 } = fakeDb();
    await recordSignal(env2 as never, {
      ...baseInput,
      action: "confirm",
      assertedValue: "ignored",
      userLat: KIOSK.lat,
      userLng: KIOSK.lng,
      accuracy: 10,
    });
    expect(runs2[0]!.bound[4]).toBeNull();
  });
});
