import { describe, expect, it } from "bun:test";
import { hasBlockingReport, kindLabel, statusLabel } from "./reports";

// Minimal D1 .prepare/.bind/.first chain that returns whatever you load
// into the constructor. Lets us assert that the SQL got the right binds
// and that hasBlockingReport reads the first() row as expected.
function makeDb(result: unknown | null): {
  env: { DB: unknown };
  binds: unknown[];
} {
  const binds: unknown[] = [];
  const chain = {
    bind: (...args: unknown[]) => {
      binds.push(...args);
      return chain;
    },
    first: () => Promise.resolve(result),
    all: () => Promise.resolve({ results: [] }),
    run: () => Promise.resolve({ success: true }),
  };
  return { env: { DB: { prepare: () => chain } }, binds };
}

describe("hasBlockingReport", () => {
  it("returns true when a non-rejected row exists", async () => {
    const { env, binds } = makeDb({ n: 1 });
    const out = await hasBlockingReport(
      env as unknown as Parameters<typeof hasBlockingReport>[0],
      "tk_fr_0001",
      "u-1",
      "wrong_hours",
    );
    expect(out).toBe(true);
    // First three binds are the WHERE-equality keys; the remaining ones are
    // the status placeholders for the IN-clause.
    expect(binds.slice(0, 3)).toEqual(["tk_fr_0001", "u-1", "wrong_hours"]);
    expect(binds.slice(3)).toEqual(["open", "pr_opened", "approved"]);
  });

  it("returns false when no row matches", async () => {
    const { env } = makeDb(null);
    const out = await hasBlockingReport(
      env as unknown as Parameters<typeof hasBlockingReport>[0],
      "tk_fr_0001",
      "u-1",
      "wrong_hours",
    );
    expect(out).toBe(false);
  });
});

describe("kindLabel", () => {
  it("translates known kinds to German", () => {
    expect(kindLabel("wrong_hours")).toBe("Öffnungszeiten");
    expect(kindLabel("update_payment")).toBe("Zahlungsarten");
  });
  it("passes unknown kinds through unchanged", () => {
    expect(kindLabel("freshly_invented_kind")).toBe("freshly_invented_kind");
  });
});

describe("statusLabel", () => {
  it("hides the PR mechanism — pr_opened and approved both read as Akzeptiert", () => {
    expect(statusLabel("open")).toBe("In Prüfung");
    expect(statusLabel("pending")).toBe("In Prüfung");
    expect(statusLabel("pr_opened")).toBe("Akzeptiert");
    expect(statusLabel("approved")).toBe("Akzeptiert");
    expect(statusLabel("merged")).toBe("Übernommen");
    expect(statusLabel("dismissed")).toBe("Abgelehnt");
  });
  it("passes unknown statuses through unchanged", () => {
    expect(statusLabel("freshly_invented_status")).toBe("freshly_invented_status");
  });
});
