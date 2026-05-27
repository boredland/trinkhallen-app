import { describe, expect, it } from "bun:test";
import { randomHandleCandidate, renameUsername, validateUsername } from "./usernames";

const HANDLE_RE = /^[a-z0-9_]{3,24}$/;

describe("validateUsername", () => {
  it("lowercases valid input rather than rejecting it", () => {
    expect(validateUsername("Jonas_S")).toEqual({ ok: true, value: "jonas_s" });
    expect(validateUsername("  B4rr4 ")).toEqual({ ok: true, value: "b4rr4" });
  });

  it("rejects the wrong shape", () => {
    expect(validateUsername("ab")).toEqual({ ok: false, reason: "invalid" });
    expect(validateUsername("a".repeat(25))).toEqual({ ok: false, reason: "invalid" });
    expect(validateUsername("has space")).toEqual({ ok: false, reason: "invalid" });
    expect(validateUsername("hä")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects reserved handles (that are long enough to reach the check)", () => {
    expect(validateUsername("admin")).toEqual({ ok: false, reason: "reserved" });
    expect(validateUsername("api")).toEqual({ ok: false, reason: "reserved" });
    // Short reserved paths like "me" never get here — they fail length first.
    expect(validateUsername("me")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("randomHandleCandidate", () => {
  it("always produces a valid, in-bounds handle", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const h = randomHandleCandidate();
      expect(h).toMatch(HANDLE_RE);
      expect(validateUsername(h).ok).toBe(true);
      seen.add(h);
    }
    // Sanity: the generator actually varies (not stuck on one combo).
    expect(seen.size).toBeGreaterThan(100);
  });
});

// Scriptable D1 fake — drives first()/run() off the SQL text so we can exercise
// every renameUsername branch without a real database.
function fakeDb(opts: {
  current?: { username: string | null; changedAt: number | null } | null;
  retired?: boolean;
  updateChanges?: number;
  throwUnique?: boolean;
}): { db: D1Database; retiredInserts: unknown[][] } {
  const retiredInserts: unknown[][] = [];
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...a: unknown[]) => {
        bound = a;
        return stmt;
      },
      first: <T>() => {
        if (sql.includes("FROM users WHERE id")) {
          return Promise.resolve((opts.current ?? null) as T);
        }
        if (sql.includes("FROM retired_usernames")) {
          return Promise.resolve((opts.retired ? ({ 1: 1 } as unknown) : null) as T);
        }
        return Promise.resolve(null as T);
      },
      run: () => {
        if (sql.startsWith("UPDATE users SET username")) {
          if (opts.throwUnique) {
            return Promise.reject(new Error("D1_ERROR: UNIQUE constraint failed: users.username"));
          }
          return Promise.resolve({ meta: { changes: opts.updateChanges ?? 1 } });
        }
        if (sql.includes("INSERT OR IGNORE INTO retired_usernames")) {
          retiredInserts.push(bound);
        }
        return Promise.resolve({ meta: { changes: 1 } });
      },
    };
    return stmt;
  };
  return { db: { prepare } as unknown as D1Database, retiredInserts };
}

describe("renameUsername", () => {
  it("rejects an invalid or reserved candidate before touching the db", async () => {
    const { db } = fakeDb({});
    expect(await renameUsername(db, "u1", "ab")).toBe("invalid");
    expect(await renameUsername(db, "u1", "admin")).toBe("reserved");
  });

  it("blocks a second rename", async () => {
    const { db } = fakeDb({ current: { username: "alt_handle", changedAt: 123 } });
    expect(await renameUsername(db, "u1", "neuer_handle")).toBe("already_changed");
  });

  it("treats the current handle as unchanged", async () => {
    const { db } = fakeDb({ current: { username: "neuer_handle", changedAt: null } });
    expect(await renameUsername(db, "u1", "Neuer_Handle")).toBe("unchanged");
  });

  it("refuses a retired handle", async () => {
    const { db } = fakeDb({ current: { username: "alt_handle", changedAt: null }, retired: true });
    expect(await renameUsername(db, "u1", "neuer_handle")).toBe("retired");
  });

  it("renames and retires the old handle on success", async () => {
    const { db, retiredInserts } = fakeDb({
      current: { username: "alt_handle", changedAt: null },
      updateChanges: 1,
    });
    expect(await renameUsername(db, "u1", "neuer_handle")).toBe("ok");
    expect(retiredInserts).toHaveLength(1);
    expect(retiredInserts[0]![0]).toBe("alt_handle");
  });

  it("reports already_changed when the guarded update matches no rows", async () => {
    const { db } = fakeDb({
      current: { username: "alt_handle", changedAt: null },
      updateChanges: 0,
    });
    expect(await renameUsername(db, "u1", "neuer_handle")).toBe("already_changed");
  });

  it("translates a UNIQUE violation to taken", async () => {
    const { db } = fakeDb({
      current: { username: "alt_handle", changedAt: null },
      throwUnique: true,
    });
    expect(await renameUsername(db, "u1", "neuer_handle")).toBe("taken");
  });

  it("returns invalid when the user row is gone", async () => {
    const { db } = fakeDb({ current: null });
    expect(await renameUsername(db, "u1", "neuer_handle")).toBe("invalid");
  });
});
