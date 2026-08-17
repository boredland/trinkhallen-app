# Plan 003: Stop the reconciliation cron starving past the first 50 open items

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 498bbb5..HEAD -- src/lib/moderation.ts src/lib/moderation.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `498bbb5`, 2026-08-16

## Why this matters

When a moderator approves a report or submission, the app opens a PR (or issue)
on the `trinkhallen-data` repo and parks the D1 row at `status = 'pr_opened'`.
An hourly cron then asks GitHub what happened to each one and moves the row to
`merged` or `dismissed`.

`pr_opened` is a **blocking status** (`src/lib/reports.ts:22`): while a row sits
there, the reporter cannot file that kind of report for that kiosk again. So a
row that never advances locks a user out permanently.

The cron reads `ORDER BY updated_at ASC LIMIT 50`. When GitHub says "still
open", the loop does `continue` without touching the row — `updated_at` stays
exactly where it was. That row therefore keeps its place at the front of the
`updated_at ASC` ordering and is re-fetched on the very next run, forever.

The consequence: **once 50 PRs are simultaneously open upstream, the query
returns the same 50 rows every hour and item 51 onwards is never checked at
all.** Those rows can never leave `pr_opened`, so their reporters are locked out
indefinitely. The bug is silent — the cron logs a successful tally each run.

After this plan, checking a row always advances its position in the queue, so
the cron rotates through every open item regardless of backlog size.

## Current state

Files:

- `src/lib/moderation.ts` — approve/reject logic plus the two reconciliation
  functions. Lines 381-435 are the relevant region.
- `src/lib/moderation.test.ts` — 526 lines, already has a
  `describe("reconcileOpenReports")` block with a purpose-built D1 stub.
- `src/index.ts:157-170` — the `scheduled` handler that calls both functions
  (read-only context; not modified by this plan).

`reconcileOpenReports`, `src/lib/moderation.ts:381-405`:

```ts
export async function reconcileOpenReports(
  env: Env,
): Promise<{ merged: number; dismissed: number }> {
  const tally = { merged: 0, dismissed: 0 };
  if (!hasGithubAppCreds(env)) return tally;

  const rows = await env.DB.prepare(
    `SELECT id, pr_url FROM reports
       WHERE status = ? AND pr_url IS NOT NULL
       ORDER BY updated_at ASC LIMIT 50`,
  )
    .bind("pr_opened")
    .all<{ id: string; pr_url: string }>();

  const now = Math.floor(Date.now() / 1000);
  for (const row of rows.results) {
    const outcome = await fetchUpstreamOutcome(env, row.pr_url);
    if (!outcome) continue;
    await env.DB.prepare(`UPDATE reports SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(outcome, now, row.id)
      .run();
    tally[outcome]++;
  }
  return tally;
}
```

`reconcileOpenSubmissions`, `src/lib/moderation.ts:411-435`, is the same shape
against the `submissions` table. **Both** have the bug and both must be fixed.

The `continue` at line 398 (and its twin at 428) is the defect: it is correct not
to change `status`, but the row's queue position must still move.

Existing tests for this function, `src/lib/moderation.test.ts:471-525`, including
the one that currently pins the buggy behaviour, at lines 493-501:

```ts
  it("leaves a still-open PR untouched rather than guessing", async () => {
    const env = makeReconcileStub([{ id: "r-3", pr_url: "https://github.com/x/y/pull/9" }]);
    fetchUpstreamOutcomeMock.mockImplementation(() => Promise.resolve(null));

    const out = await reconcileOpenReports(env as unknown as ReconcileEnv);

    expect(out).toEqual({ merged: 0, dismissed: 0 });
    expect(env.updates).toHaveLength(0);
  });
```

**You will need to update this test.** Its intent — "don't guess a status for a
still-open PR" — stays valid and must keep being asserted. What changes is
`expect(env.updates).toHaveLength(0)`: after the fix there *is* a write, it just
must not be a status change. Rewrite the assertion to pin the real invariant
(status untouched, queue position advanced), and keep the test name honest.

The D1 stub available to you, `src/lib/moderation.test.ts:443-467`, records every
non-SELECT `bind()` call into `env.updates` and every SQL string into `env.sqls`.

Repo conventions:

- Comments explain **why**. The reconciliation functions already carry a long
  explanatory header at `moderation.ts:365-380` — extend that reasoning rather
  than restating mechanics.
- SQL is always parameter-bound, never interpolated. There is even a regression
  test for this at `moderation.test.ts:514-525`.
- Timestamps are `Math.floor(Date.now() / 1000)` (integer seconds) everywhere.

## Commands you will need

| Purpose   | Command                            | Expected on success        |
|-----------|------------------------------------|----------------------------|
| Install   | `bun install`                      | exit 0                     |
| Typecheck | `bun run typecheck`                | exit 0, no output          |
| Focused tests | `bun test src/lib/moderation.test.ts` | all pass              |
| Tests     | `bun test`                         | all pass (114 before this plan) |
| Lint      | `bun run lint`                     | exit 0, "No fixes applied" |

## Scope

**In scope** (the only files you should modify):

- `src/lib/moderation.ts`
- `src/lib/moderation.test.ts`

**Out of scope** (do NOT touch, even though they look related):

- `src/index.ts` — the `scheduled` handler needs no change; both functions keep
  their current signatures and return shape.
- `migrations/` — **do not add a migration**. Do not add a `last_checked_at`
  column. Reusing the existing `updated_at` column is the whole point: D1
  migrations are not auto-applied (`AGENTS.md`), so a schema change turns a
  one-line fix into a deploy-coordination problem for no behavioural gain.
- The `LIMIT 50` batch size — leave it. With rotation working, 50/hour clears
  any realistic backlog.
- `src/lib/reports.ts` and `BLOCKING_STATUSES` — the blocking semantics are
  correct; the bug is that rows never leave the blocking status.

## Git workflow

- Branch: `advisor/003-reconcile-starvation`
- One commit. Message style from `git log`: the feature that introduced this
  code was `Reconcile pr_opened reports/submissions against GitHub on a cron`.
  Use: `fix(cron): rotate still-open rows so reconciliation can't starve`
- Do NOT push or open a PR.

## Steps

### Step 1: Write the failing test for queue rotation

In `src/lib/moderation.test.ts`, inside the existing
`describe("reconcileOpenReports")` block (starts at line 471), add a test
asserting that a still-open PR gets its `updated_at` advanced without its
`status` changing.

The stub records `bind()` argument arrays in `env.updates`. After the fix, a
still-open row must produce exactly one recorded write whose bound arguments
carry the row id and a fresh timestamp, and which does **not** set a terminal
status. Assert on `env.sqls` too: the UPDATE issued for a still-open row must
not contain `status =`.

Name it for the invariant, e.g.
`"advances updated_at on a still-open PR so the next run reaches other rows"`.

Add the same test to a `describe("reconcileOpenSubmissions")` block. That
describe does not exist yet — create it, and import `reconcileOpenSubmissions`
by extending the destructured import at `moderation.test.ts:38-40`. Reuse
`makeReconcileStub` as-is; it is table-agnostic.

**Verify**: `bun test src/lib/moderation.test.ts` → the two new tests FAIL
(no write is recorded today). Existing tests still pass at this point.

### Step 2: Advance `updated_at` for still-open rows

In `src/lib/moderation.ts`, in **both** `reconcileOpenReports` (line ~396) and
`reconcileOpenSubmissions` (line ~426), replace the bare `continue` on a null
outcome with a touch of `updated_at` on that row, then continue.

Requirements:

- The touch updates **only** `updated_at`. It must not write `status`,
  `pr_url`, or any moderation column.
- Parameter-bind both values — never interpolate.
- Add a short comment explaining *why* the touch exists: without it, an
  unresolved row keeps its place at the head of the `updated_at ASC` ordering
  and the same 50 rows are re-checked forever, so anything past the batch size
  is never reconciled and its reporter stays blocked.

Also extend the function-header comment at `moderation.ts:379`, which currently
reads "Rows whose lookup fails or is still open are left alone and retried next
run." That sentence is now misleading — they are retried, but they go to the
back of the queue. Say so.

Consider whether a lookup **failure** (as opposed to a confirmed still-open)
should also rotate. `fetchUpstreamOutcome` returns `null` for both cases, so the
touch necessarily covers both. That is the correct behaviour — a row whose
lookup keeps erroring must not be allowed to block the queue head either — but
note it in the comment so the conflation is deliberate rather than accidental.

**Verify**: `bun test src/lib/moderation.test.ts` → all pass, including the two
new tests and the updated still-open test from Step 3 if you have already done it.

### Step 3: Update the existing still-open test to match the new contract

Rewrite `"leaves a still-open PR untouched rather than guessing"` at
`src/lib/moderation.test.ts:493-501`.

Keep asserting what still holds: the tally stays `{ merged: 0, dismissed: 0 }`
and no terminal status is written. Replace `expect(env.updates).toHaveLength(0)`
— which now pins the bug rather than the behaviour — with an assertion that the
only write performed was the timestamp touch.

Rename the test so it states the surviving invariant, e.g.
`"never guesses a status for a still-open PR"`.

**Verify**: `bun test src/lib/moderation.test.ts` → all pass.

### Step 4: Full suite

**Verify**:
- `bun run typecheck` → exit 0
- `bun run lint` → exit 0
- `bun test` → all pass; 114 + your new tests

## Test plan

New tests in `src/lib/moderation.test.ts`:

1. `reconcileOpenReports`: a still-open PR advances `updated_at` and writes no
   status.
2. `reconcileOpenSubmissions`: the same (in a new `describe` block).
3. Updated: the existing still-open test, rewritten to assert the surviving
   invariant instead of the old zero-writes behaviour.

Optionally strengthen: a two-row batch where the first is still open and the
second is merged, asserting both are processed in one run (the merged row still
transitions, the open row still rotates).

Structural pattern: the existing `describe("reconcileOpenReports")` block at
`src/lib/moderation.test.ts:471-525` and its `makeReconcileStub` helper at
lines 443-467. Do not write a new stub.

Verification: `bun test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun test` exits 0, all tests passing
- [ ] `grep -n 'if (!outcome) continue;' src/lib/moderation.ts` returns **no**
      matches (both bare continues replaced)
- [ ] Two timestamp-only UPDATEs exist, one per reconcile function. The exact
      SQL text is yours to choose, so verify by reading the two functions rather
      than by a brittle grep: each must issue an UPDATE that binds only a
      timestamp and a row id, and sets no `status` column.
- [ ] `src/lib/moderation.test.ts` contains a `describe("reconcileOpenSubmissions")` block
- [ ] `git status --short` lists only `src/lib/moderation.ts` and
      `src/lib/moderation.test.ts` (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `SELECT` in either function no longer uses `ORDER BY updated_at ASC LIMIT 50`
  — the starvation mechanism has changed and this fix may be wrong.
- `fetchUpstreamOutcome` no longer returns `null` for "still open" (e.g. it
  gained a distinct error signal) — the plan's conflation of failure and
  still-open needs revisiting with that new information.
- You conclude a schema change is needed. It is not; report why you think so
  rather than adding a migration.
- Any existing test outside the two you were told to change starts failing.

## Maintenance notes

- **Invariant to preserve**: every row the cron *examines* must have its
  `updated_at` advanced, whatever the outcome. Any future branch added to that
  loop (a third terminal state, a skip condition, an early `continue`) must
  touch the timestamp or it reintroduces starvation. A reviewer should check
  exactly this on any change to the reconcile loop.
- `updated_at` on these tables now means "last time we looked at this row",
  not "last time the row's content changed". If a future feature needs true
  content-modification time, it needs its own column — and at that point the
  rotation should move to a dedicated `last_checked_at`.
- The related latent risk, deliberately **not** addressed here: with a large
  backlog the loop issues up to 50 sequential GitHub API calls inside
  `ctx.waitUntil`. At current volume that is fine. If the backlog ever
  approaches the batch size routinely, revisit batching/concurrency and the
  Worker CPU-time ceiling together.
