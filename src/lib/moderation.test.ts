import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Mock the GitHub HTTP layer before importing moderation. Both modules need
// to be in place before the unit under test pulls them in, otherwise the
// real implementations get bound at import time.
const proposeChangeMock = mock<
  (
    env: unknown,
    args: {
      path: string;
      branch: string;
      mutate: (text: string) => string;
      commitMessage: string;
      prTitle: string;
      prBody: string;
    },
  ) => Promise<{ html_url: string; number: number } | null>
>(() => Promise.resolve({ html_url: "https://github.com/x/y/pull/1", number: 1 }));
const openIssueViaPrMock = mock<
  (env: unknown, args: { title: string }) => Promise<{ html_url: string; number: number } | null>
>(() => Promise.resolve({ html_url: "https://github.com/x/y/issues/9", number: 9 }));
const hasGithubAppCredsMock = mock<(env: unknown) => boolean>(() => true);

mock.module("./github-pr", () => ({
  proposeChange: (...args: Parameters<typeof proposeChangeMock>) => proposeChangeMock(...args),
  openIssueViaPr: (...args: Parameters<typeof openIssueViaPrMock>) => openIssueViaPrMock(...args),
}));
mock.module("./github-app", () => ({
  hasGithubAppCreds: (...args: Parameters<typeof hasGithubAppCredsMock>) =>
    hasGithubAppCredsMock(...args),
}));

const { applyReportPatch, approveReport, rejectReport } = await import("./moderation");

// Minimal D1 stub: every call resolves successfully; nothing is persisted.
// The DB writes inside approveReport/rejectReport are fire-and-forget from
// the caller's perspective, so we only need .run() to not throw.
interface StubBound {
  bind: (...args: unknown[]) => StubBound;
  run: () => Promise<{ success: boolean }>;
  first: <T>() => Promise<T | null>;
}
const makeStub = (): { DB: { prepare: (sql: string) => StubBound }; calls: unknown[][] } => {
  const calls: unknown[][] = [];
  const bound: StubBound = {
    bind: (...args: unknown[]) => {
      calls.push(args);
      return bound;
    },
    run: () => Promise.resolve({ success: true }),
    first: () => Promise.resolve(null),
  };
  return { DB: { prepare: () => bound }, calls };
};

const kiosk = (overrides: Partial<{ id: string; region: string; name: string }> = {}) => ({
  id: "tk_fr_0042",
  region: "frankfurt",
  name: "Trinkhalle Eichenloh",
  ...overrides,
});

const report = (
  overrides: Partial<{
    kind: string;
    payload: string | null;
  }> = {},
) => ({
  id: "r-1234",
  kiosk_id: "tk_fr_0042",
  user_id: "u-1",
  status: "open",
  pr_url: null,
  created_at: 0,
  kind: "wrong_hours",
  payload: null,
  ...overrides,
});

const moderator = {
  id: "mod-1",
  displayName: "Mod",
  username: null as string | null,
  email: "mod@trinkhallen.app",
};

beforeEach(() => {
  proposeChangeMock.mockClear();
  openIssueViaPrMock.mockClear();
  hasGithubAppCredsMock.mockClear();
  proposeChangeMock.mockImplementation(() =>
    Promise.resolve({ html_url: "https://github.com/x/y/pull/1", number: 1 }),
  );
  openIssueViaPrMock.mockImplementation(() =>
    Promise.resolve({ html_url: "https://github.com/x/y/issues/9", number: 9 }),
  );
  hasGithubAppCredsMock.mockImplementation(() => true);
});

afterEach(() => {
  proposeChangeMock.mockReset();
  openIssueViaPrMock.mockReset();
  hasGithubAppCredsMock.mockReset();
});

// ── applyReportPatch: structured patches against a real-shaped GeoJSON ─────

const buildDoc = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [8.68, 50.11] },
        properties: {
          id: "tk_fr_0042",
          name: "Trinkhalle Eichenloh",
          address: { street: "Eichenloh", number: "12" },
          tags: ["snacks"],
          payment: { cash: "yes" },
          hours: { raw: "Mo-Fr 08:00-22:00" },
          ...overrides,
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [8.69, 50.11] },
        properties: { id: "tk_fr_0043", name: "Other Kiosk" },
      },
    ],
  });

describe("applyReportPatch", () => {
  it("rewrites opening hours on wrong_hours", () => {
    const out = applyReportPatch(buildDoc(), "tk_fr_0042", "wrong_hours", {
      new_hours: "24/7",
    });
    const doc = JSON.parse(out) as { features: Array<{ properties: Record<string, unknown> }> };
    expect((doc.features[0]!.properties["hours"] as { raw: string }).raw).toBe("24/7");
    expect(doc.features[0]!.properties["updated"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("merges address fields on wrong_address (preserves untouched keys)", () => {
    const out = applyReportPatch(buildDoc(), "tk_fr_0042", "wrong_address", {
      new_address: { number: "14" },
    });
    const doc = JSON.parse(out) as { features: Array<{ properties: Record<string, unknown> }> };
    const addr = doc.features[0]!.properties["address"] as Record<string, string>;
    expect(addr).toEqual({ street: "Eichenloh", number: "14" });
  });

  it("rewrites name on wrong_name", () => {
    const out = applyReportPatch(buildDoc(), "tk_fr_0042", "wrong_name", { new_name: "Foo" });
    const doc = JSON.parse(out) as { features: Array<{ properties: Record<string, unknown> }> };
    expect(doc.features[0]!.properties["name"]).toBe("Foo");
  });

  it("on closed: deletes the feature from the FeatureCollection", () => {
    // Regression test: previously `closed` set a `closed:true` flag that
    // wasn't in the schema and nothing read. Should now splice the feature.
    const out = applyReportPatch(buildDoc(), "tk_fr_0042", "closed", {});
    const doc = JSON.parse(out) as { features: Array<{ properties: { id: string } }> };
    expect(doc.features.map((f) => f.properties.id)).toEqual(["tk_fr_0043"]);
    expect(doc.features.some((f) => "closed" in f.properties)).toBe(false);
  });

  it("conservatively fills payment (never overwrites known values)", () => {
    const out = applyReportPatch(buildDoc(), "tk_fr_0042", "update_payment", {
      payment: { cash: "no", cards: "yes" },
    });
    const doc = JSON.parse(out) as { features: Array<{ properties: Record<string, unknown> }> };
    const pay = doc.features[0]!.properties["payment"] as Record<string, string>;
    expect(pay["cash"]).toBe("yes"); // pre-existing, not overwritten
    expect(pay["cards"]).toBe("yes"); // newly filled
  });

  it("adds and removes tags on update_tags", () => {
    const out = applyReportPatch(buildDoc(), "tk_fr_0042", "update_tags", {
      add_tags: ["wc"],
      remove_tags: ["snacks"],
    });
    const doc = JSON.parse(out) as { features: Array<{ properties: { tags: string[] } }> };
    expect(doc.features[0]!.properties.tags).toEqual(["wc"]);
  });

  it("throws for unknown kinds", () => {
    expect(() => applyReportPatch(buildDoc(), "tk_fr_0042", "made_up", {})).toThrow(
      /unsupported kind/,
    );
  });

  it("throws when the feature id is missing", () => {
    expect(() => applyReportPatch(buildDoc(), "tk_does_not_exist", "wrong_hours", {})).toThrow(
      /not found/,
    );
  });
});

// ── approveReport: dispatch + GitHub mocking ────────────────────────────────

describe("approveReport", () => {
  it("opens a PR for kinds with a structured patch (wrong_hours)", async () => {
    const env = makeStub();
    const out = await approveReport(
      env as unknown as Parameters<typeof approveReport>[0],
      report({ kind: "wrong_hours", payload: JSON.stringify({ new_hours: "24/7" }) }),
      kiosk(),
      moderator,
    );
    expect(out.status).toBe("pr_opened");
    expect(out.prUrl).toBe("https://github.com/x/y/pull/1");
    expect(proposeChangeMock).toHaveBeenCalledTimes(1);
    expect(openIssueViaPrMock).not.toHaveBeenCalled();
    // The path argument must be the resolved file path for the slug.
    const args = proposeChangeMock.mock.calls[0]![1] as { path: string };
    expect(args.path).toBe("data/de/hessen/frankfurt.geojson");
  });

  it("opens a PR for closed (deletion path)", async () => {
    const env = makeStub();
    const out = await approveReport(
      env as unknown as Parameters<typeof approveReport>[0],
      report({ kind: "closed" }),
      kiosk(),
      moderator,
    );
    expect(out.status).toBe("pr_opened");
    expect(proposeChangeMock).toHaveBeenCalledTimes(1);
    expect(openIssueViaPrMock).not.toHaveBeenCalled();
  });

  it("opens an issue (not a PR) for duplicate kind", async () => {
    const env = makeStub();
    const out = await approveReport(
      env as unknown as Parameters<typeof approveReport>[0],
      report({ kind: "duplicate" }),
      kiosk(),
      moderator,
    );
    expect(out.status).toBe("pr_opened"); // status field gets `pr_opened` for issues too — see openReportAsIssue
    expect(openIssueViaPrMock).toHaveBeenCalledTimes(1);
    expect(proposeChangeMock).not.toHaveBeenCalled();
    expect(out.prUrl).toContain("/issues/");
  });

  it("falls back to issue when the slug doesn't resolve", async () => {
    // Regression test: previously, even valid Frankfurt kiosks fell here
    // because the lookup was by *path* not by *slug*. Now an unknown slug
    // is the only thing that should land in this branch.
    const env = makeStub();
    const out = await approveReport(
      env as unknown as Parameters<typeof approveReport>[0],
      report({ kind: "wrong_hours", payload: JSON.stringify({ new_hours: "24/7" }) }),
      kiosk({ region: "atlantis" }),
      moderator,
    );
    expect(out.status).toBe("pr_opened");
    expect(openIssueViaPrMock).toHaveBeenCalledTimes(1);
    expect(proposeChangeMock).not.toHaveBeenCalled();
  });

  it("marks the report 'approved' when GitHub App creds are absent", async () => {
    hasGithubAppCredsMock.mockImplementation(() => false);
    const env = makeStub();
    const out = await approveReport(
      env as unknown as Parameters<typeof approveReport>[0],
      report({ kind: "wrong_hours", payload: JSON.stringify({ new_hours: "24/7" }) }),
      kiosk(),
      moderator,
    );
    expect(out.status).toBe("approved");
    expect(proposeChangeMock).not.toHaveBeenCalled();
  });

  it("returns skipped_no_change when proposeChange yields no diff", async () => {
    proposeChangeMock.mockImplementation(() => Promise.resolve(null));
    const env = makeStub();
    const out = await approveReport(
      env as unknown as Parameters<typeof approveReport>[0],
      report({ kind: "wrong_hours", payload: JSON.stringify({ new_hours: "24/7" }) }),
      kiosk(),
      moderator,
    );
    expect(out.status).toBe("skipped_no_change");
  });
});

// ── moderator handle: PR/issue "Approved by" rendering ─────────────────────

describe("moderator handle in PR/issue body", () => {
  // Capture the body that approveReport passes to proposeChange so we can
  // assert on the rendered "Approved by" line for each moderator shape.
  const captureBody = (): { get current(): string | null } => {
    const state: { current: string | null } = { current: null };
    proposeChangeMock.mockImplementation((_env, args) => {
      state.current = (args as { prBody: string }).prBody;
      return Promise.resolve({ html_url: "https://github.com/x/y/pull/1", number: 1 });
    });
    return {
      get current() {
        return state.current;
      },
    };
  };

  it("prefers @username over displayName and email-prefix", async () => {
    const cap = captureBody();
    const env = makeStub();
    await approveReport(
      env as unknown as Parameters<typeof approveReport>[0],
      report({ kind: "wrong_hours", payload: JSON.stringify({ new_hours: "24/7" }) }),
      kiosk(),
      { ...moderator, username: "jonas_s", displayName: "Jonas Strasel" },
    );
    expect(cap.current).toContain("**Approved by**: @jonas_s");
  });

  it("falls back to displayName when no username", async () => {
    const cap = captureBody();
    const env = makeStub();
    await approveReport(
      env as unknown as Parameters<typeof approveReport>[0],
      report({ kind: "wrong_hours", payload: JSON.stringify({ new_hours: "24/7" }) }),
      kiosk(),
      { ...moderator, username: null, displayName: "Jonas Strasel" },
    );
    expect(cap.current).toContain("**Approved by**: Jonas Strasel");
  });

  it("falls back to the email local-part only as last resort", async () => {
    // Regression test: a magic-link signup with email `info@jonas-strassel.de`
    // and no username/displayName previously rendered as "Approved by: info",
    // which read like a system label. Still acceptable as the final fallback
    // when nothing better exists.
    const cap = captureBody();
    const env = makeStub();
    await approveReport(
      env as unknown as Parameters<typeof approveReport>[0],
      report({ kind: "wrong_hours", payload: JSON.stringify({ new_hours: "24/7" }) }),
      kiosk(),
      { ...moderator, username: null, displayName: null, email: "info@example.de" },
    );
    expect(cap.current).toContain("**Approved by**: info");
  });
});

// ── rejectReport: status transition only, no GitHub side effects ────────────

describe("rejectReport", () => {
  it("writes status='dismissed' and does not call GitHub", async () => {
    const env = makeStub();
    await rejectReport(
      env as unknown as Parameters<typeof rejectReport>[0],
      report({ kind: "wrong_hours" }),
      moderator,
      "not enough info",
    );
    expect(proposeChangeMock).not.toHaveBeenCalled();
    expect(openIssueViaPrMock).not.toHaveBeenCalled();
    // First D1 bind() call is the UPDATE; status is positional arg 0.
    const args = env.calls[0]!;
    expect(args[0]).toBe("dismissed");
  });
});
