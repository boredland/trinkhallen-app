# Plan 007: Put the auth core under unit tests (session, magic link, Turnstile)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ea4c963..HEAD -- src/lib/session.ts src/lib/magic.ts src/lib/turnstile.ts src/lib/session.test.ts src/lib/magic.test.ts src/lib/turnstile.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `ea4c963`, 2026-10-10

## Why this matters

Login is the only door to every contribution feature, and the modules behind
it have **no unit tests at all**: `src/lib/session.ts` (signed session
cookies), `src/lib/magic.ts` (email login links) and `src/lib/turnstile.ts`
(bot gate). The e2e suite never performs a real login either — it inserts a
session row and signs the cookie itself (`tests/e2e/auth.ts:41-73`).

A follow-up plan (008) changes how magic links are redeemed. Before anyone
touches that code, the current behaviour must be pinned so a regression shows
up as a red test, not as users who can't log in. This plan only **adds tests**
— it changes no production code.

## Current state

### `src/lib/session.ts` (187 lines)

Cookie value is `<sid>.<base64url HMAC-SHA256(sid, SESSION_SECRET)>`; the
`sessions` table stores `sid`, `user_id`, `expires_at`, `created_at`.

- `createSession(c, userId)` (lines 42-65): inserts the row with
  `expires_at = now + SESSION_TTL_SEC` (30 days), signs the sid, sets cookie
  `__Host-tk_sess` with `httpOnly, secure, sameSite: "Lax", path: "/"`.
- `loadSession(c)` (lines 67-132):

```ts
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const sid = await verify(raw, c.env.SESSION_SECRET);
  if (!sid) return null;
  const row = await c.env.DB.prepare(`SELECT s.id AS sid, s.expires_at AS expires_at, u.id AS user_id, u.email, u.username, u.role, u.google_sub, u.apple_sub FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).bind(sid).first<…>();
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run();
    return null;
  }
  // Sliding TTL: refresh if the cookie is more than a day from expiring.
  if (row.expires_at - now < SESSION_TTL_SEC - 24 * 60 * 60) {
    const newExpiry = now + SESSION_TTL_SEC;
    c.executionCtx.waitUntil(c.env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).bind(newExpiry, sid).run());
    // …re-signs and re-sets the cookie
  }
  const hasGoogle = !row.google_sub.startsWith("email:") && !row.google_sub.startsWith("apple:");
  const hasApple = !!row.apple_sub;
  return { id: row.user_id, email: row.email, username: row.username, role: row.role,
           isMagicLinkOnly: !hasGoogle && !hasApple, hasGoogle, hasApple };
```

- `destroySession(c)` (lines 134-141): verifies the cookie, deletes the row,
  deletes the cookie.
- `sign`/`verify`/`timingSafeEqual` are **not exported**. Test them through the
  public functions only. Do not export them for testing.

### `src/lib/magic.ts` (120 lines)

- `MAGIC_TTL_SEC = 15 * 60`; at most 5 unconsumed, unexpired tokens per email.
- `mintMagicLink(env, email, meta)` (lines 24-53): `SELECT COUNT(*) AS n FROM
  magic_links WHERE email = ? AND consumed_at IS NULL AND expires_at > ?`; if
  `n >= 5` returns `null`; else inserts `(id, token_hash, email, expires_at,
  created_at, user_agent, ip)` where `token_hash = sha256hex(token)`; returns
  `{ id, token }` (id = 32 hex chars, token = 64 hex chars).
- `redeemMagicLink(env, rawToken)` (lines 59-90): splits `<id>.<token>` on the
  first `.`; returns `null` for a missing dot, unknown id, already-consumed row,
  expired row, or hash mismatch; then runs

```ts
  const consume = await env.DB.prepare(
    `UPDATE magic_links SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`,
  ).bind(now, id).run();
  if (consume.meta.changes === 0) return null;
  return { email: row.email };
```

  The conditional UPDATE is the single-use guarantee: two concurrent redeems
  both pass the SELECT, exactly one gets `changes === 1`.
- `isValidEmail(s)` (lines 92-95): `/^[^\s@<>"]+@[^\s@.]+(?:\.[^\s@.]+)+$/` and
  `length <= 254`.

### `src/lib/turnstile.ts` (56 lines)

```ts
export async function verifyTurnstile(env: { TURNSTILE_SECRET_KEY?: string }, token: string | null, remoteIp: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;   // documented: empty secret disables the gate
  if (!token) return false;
  // POST FormData { secret, response, remoteip? } to SITEVERIFY_URL
  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) { console.error(…); return false; }
    const outcome = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!outcome.success) { console.warn(…); return false; }
    return true;
  } catch (err) { console.error(…); return false; }
}
```

`SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"`,
`TURNSTILE_FIELD = "cf-turnstile-response"`. The fail-open on an empty secret
is a **recorded design decision** (module header lines 13-15) — the test must
pin it, not "fix" it.

### Test conventions to copy

- Framework: `bun:test` (`describe`, `it`, `expect`, `beforeEach`, `afterEach`).
  Test files sit next to the module: `src/lib/<module>.test.ts`.
- Hand-rolled D1 fakes, no mocking library. Exemplar
  `src/lib/signals.test.ts:15-37`:

```ts
function fakeDb(opts: { dedupe?: boolean } = {}): { env: { DB: D1Database }; runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...a: unknown[]) => { bound = a; return stmt; },
      first: () => Promise.resolve(null),
      run: () => { runs.push({ sql, bound }); return Promise.resolve({ meta: { changes: opts.dedupe ? 0 : 1 } }); },
    };
    return stmt;
  };
  return { env: { DB: { prepare } as unknown as D1Database }, runs };
}
```

- Casting a partial env: `as unknown as Env` (see `src/lib/notify.test.ts:38-40`).
- Comments explain *why* a case exists, not what the assertion does.

## Commands you will need

| Purpose   | Command                                      | Expected on success              |
|-----------|----------------------------------------------|----------------------------------|
| Install   | `bun install`                                | exit 0                           |
| Typecheck | `bun run typecheck`                          | exit 0                           |
| Focused   | `bun test src/lib/session.test.ts src/lib/magic.test.ts src/lib/turnstile.test.ts` | all pass |
| Tests     | `bun test`                                   | all pass (149 before this plan)  |
| Lint      | `bun run lint`                               | exit 0, "No fixes applied"       |

## Scope

**In scope** (create only):

- `src/lib/session.test.ts`
- `src/lib/magic.test.ts`
- `src/lib/turnstile.test.ts`

**Out of scope** (do NOT touch):

- `src/lib/session.ts`, `src/lib/magic.ts`, `src/lib/turnstile.ts` — no
  production change, not even to export helpers. If a behaviour cannot be
  reached through the public API, skip that case and note it in your report.
- `src/routes/auth.tsx` — route-level magic-link tests belong to plan 008,
  which rewrites that handler.
- `tests/e2e/**` — no e2e changes.
- `src/lib/apple-auth.ts` — needs JWT/key fixtures; deliberately deferred.

## Git workflow

- Branch: `advisor/007-auth-characterization-tests`
- One commit: `test(auth): characterize session, magic-link and turnstile`
- Do NOT push or open a PR.

## Steps

### Step 1: `src/lib/session.test.ts`

`createSession`, `loadSession` and `destroySession` take a Hono `Context`. Do
not hand-build a Context. Drive them through a throwaway Hono app, which gives
you real cookie parsing and `Set-Cookie` output:

```ts
import { Hono } from "hono";
import type { Env } from "../env";
import { createSession, destroySession, loadSession, SESSION_COOKIE, SESSION_TTL_SEC } from "./session";

function harness(db: D1Database) {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/login", async (c) => { await createSession(c, "u1"); return c.text("ok"); });
  app.get("/me", async (c) => c.json(await loadSession(c)));
  app.post("/logout", async (c) => { await destroySession(c); return c.text("ok"); });
  const env = { DB: db, SESSION_SECRET: "test-secret" } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  return { request: (path: string, init?: RequestInit) => app.request(path, init, env, ctx), pending };
}
```

Write an in-memory D1 fake for `sessions` joined to one `users` row. It must:

- record INSERT/UPDATE/DELETE `run()` calls (sql + bound args), and
- answer the `loadSession` SELECT with a row you control: `null` (no row),
  or `{ sid, expires_at, user_id, email, username, role, google_sub, apple_sub }`.

Pull the cookie from the `/login` response's `set-cookie` header
(`<name>=<value>; …` → take the value before the first `;`) and send it back as
`cookie: __Host-tk_sess=<value>`.

Cases (each an `it`):

1. `createSession` inserts one `sessions` row whose bound `expires_at` is
   `created_at + SESSION_TTL_SEC`, and sets a cookie with `HttpOnly`,
   `Secure`, `SameSite=Lax`, `Path=/`, and `Max-Age=2592000`.
2. A cookie from `createSession` round-trips: `loadSession` returns the user.
3. A cookie whose HMAC was altered (flip the last character) → `null`, and the
   DB fake records **no** SELECT (rejected before touching D1).
4. A cookie with no `.` → `null`.
5. A cookie signed with a different secret (build it with a second harness
   using `SESSION_SECRET: "other"`) → `null` against the first harness.
6. Valid cookie but no matching row → `null`.
7. Expired row (`expires_at = now - 1`) → `null` **and** a
   `DELETE FROM sessions WHERE id = ?` was run with that sid.
8. Sliding TTL: a row expiring in 10 days → after `await
   Promise.all(pending)`, an `UPDATE sessions SET expires_at = ?` was run with
   a value ≈ `now + SESSION_TTL_SEC` (allow ±5 s), and the response sets a
   fresh cookie.
9. No refresh for a fresh row: a row expiring in `SESSION_TTL_SEC - 3600` →
   no UPDATE recorded, no `set-cookie` on the response.
10. Provider flags, table-driven over `google_sub` / `apple_sub`:
    - `email:a@b.c`, `null` → `isMagicLinkOnly: true, hasGoogle: false, hasApple: false`
    - `apple:xyz`, `"xyz"` → `isMagicLinkOnly: false, hasGoogle: false, hasApple: true`
    - `1234567890`, `null` → `isMagicLinkOnly: false, hasGoogle: true, hasApple: false`
11. `destroySession` with a valid cookie runs
    `DELETE FROM sessions WHERE id = ?` with the sid and the response clears
    `__Host-tk_sess` (`Max-Age=0` in `set-cookie`).

**Verify**: `bun test src/lib/session.test.ts` → all pass.

### Step 2: `src/lib/magic.test.ts`

`mintMagicLink` and `redeemMagicLink` take `env` with `DB`. Build a small
**stateful** fake that keeps `magic_links` rows in a `Map<id, row>` and
understands exactly these four statements (match on a SQL substring):

| SQL contains                                   | method  | behaviour |
|-----------------------------------------------|---------|-----------|
| `SELECT COUNT(*) AS n FROM magic_links`        | `first` | count rows with `email = ?1`, `consumed_at == null`, `expires_at > ?2` |
| `INSERT INTO magic_links`                      | `run`   | store the row from the 7 bound values |
| `SELECT email, token_hash, expires_at, consumed_at FROM magic_links WHERE id = ?` | `first` | return the row or `null` |
| `UPDATE magic_links SET consumed_at = ?`       | `run`   | set `consumed_at` only if currently null; return `{ meta: { changes: 1 or 0 } }` |

Throw on any other SQL so a future query change fails loudly.

Cases:

1. `mint` returns `{ id, token }` with `id` 32 lowercase hex chars and `token`
   64; the stored row has `token_hash` ≠ `token` (only the hash is stored) and
   `expires_at - created_at === 900`.
2. `mint` stores the given `userAgent` and `ip`.
3. Round trip: `redeem(env, \`${id}.${token}\`)` → `{ email }`.
4. Single use: a second `redeem` of the same token → `null`.
5. Concurrent redeem: `Promise.all([redeem(t), redeem(t)])` → exactly one
   `{ email }` and one `null`. (Your fake's UPDATE must honour
   `consumed_at IS NULL` for this to be meaningful.)
6. Expired: set the stored row's `expires_at` to the past → `null`, and the row
   stays unconsumed.
7. Wrong token for a real id → `null`, row stays unconsumed.
8. Malformed input → `null` for each of: `""`, `"nodot"`, `".token"`,
   `"id."`, `"unknownid.token"`.
9. Rate cap: five `mint`s for the same email return links; the sixth returns
   `null`; a mint for a different email still succeeds.
10. The cap counts only *outstanding* links: after consuming one of the five,
    a sixth mint succeeds.
11. `isValidEmail`, table-driven: accepts `a@b.de`, `first.last+tag@sub.example.org`;
    rejects `""`, `"a@b"`, `"a b@c.de"`, `"<a@b.de>"`, `"a@.de"`, and a
    255-character address.

**Verify**: `bun test src/lib/magic.test.ts` → all pass.

### Step 3: `src/lib/turnstile.test.ts`

Stub `globalThis.fetch` in `beforeEach`, restore it in `afterEach` (save the
original in a module-level `const realFetch = globalThis.fetch`). Record each
call's URL and parse its `FormData` body.

Cases:

1. **Documented fail-open**: empty/absent `TURNSTILE_SECRET_KEY` → `true`,
   and `fetch` was **not** called. Comment the test with the reason from the
   module header (local dev and pre-secret deploys keep working) so nobody
   "fixes" it without reading the decision.
2. Secret set, `token === null` → `false`, no fetch.
3. Secret set, siteverify answers `{ success: true }` → `true`; the request
   went to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with
   method `POST` and form fields `secret`, `response` (the token), `remoteip`
   (the IP).
4. `remoteIp === null` → no `remoteip` field in the form.
5. siteverify `{ success: false, "error-codes": ["invalid-input-response"] }`
   → `false`.
6. siteverify HTTP 500 → `false`.
7. `fetch` rejects (network error) → `false` (fails closed).

`console.error`/`console.warn` output during cases 5-7 is expected; do not
silence it by editing the module.

**Verify**: `bun test src/lib/turnstile.test.ts` → all pass.

### Step 4: Full suite

**Verify**:
- `bun run typecheck` → exit 0
- `bun run lint` → exit 0 (run `bun run lint:fix` only on the three new files
  if formatting is the only complaint)
- `bun test` → all pass; count = 149 + the tests you added

## Test plan

This plan *is* the test plan: three new files, ~30 cases, covering the happy
path, tamper/expiry/replay rejection, the sliding-TTL refresh, the single-use
race, the per-email cap, and Turnstile's fail-closed paths plus its one
documented fail-open.

Patterns: D1 fakes after `src/lib/signals.test.ts:15-37`; env casts after
`src/lib/notify.test.ts:38-40`; app-level requests after
`src/routes/csrf-coverage.test.ts`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun test` exits 0
- [ ] `src/lib/session.test.ts`, `src/lib/magic.test.ts`,
      `src/lib/turnstile.test.ts` exist and each has ≥ 7 `it(` blocks
- [ ] `git diff --stat ea4c963..HEAD -- src/lib/session.ts src/lib/magic.ts src/lib/turnstile.ts`
      is empty (no production change)
- [ ] Mutation check, report each result: (a) in `magic.ts` change
      `AND consumed_at IS NULL` in the UPDATE to nothing → case 4 or 5 fails;
      (b) in `session.ts` change `row.expires_at < now` to `false` → case 7
      fails; (c) in `turnstile.ts` change `return false` in the `catch` to
      `return true` → case 7 fails. Revert every mutation afterwards and
      confirm `git diff -- src/lib/*.ts` shows only the new test files.
- [ ] `git status --short` lists only the three new test files (plus
      `plans/README.md`)
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any case can only be tested by exporting a private helper or changing a
  production file.
- `loadSession`'s sliding-refresh branch cannot be exercised because
  `c.executionCtx` throws in `app.request` even with the `ctx` argument
  passed (the 4th parameter of `app.request` is the execution context).
- A test reveals behaviour that contradicts the "Current state" section (e.g.
  the cap counts expired links, or a tampered cookie reaches the DB). Do not
  "fix" production code — record the observed behaviour in the report; it is a
  finding.

## Maintenance notes

- Plan 008 rewrites `GET /auth/magic/verify`. It relies on `magic.test.ts`
  cases 3-5 staying green; any change to `redeemMagicLink`'s signature must
  update these tests in the same commit.
- The SQL-substring fakes are deliberately strict (unknown SQL throws). When a
  query in these modules changes, update the fake with it — that friction is
  the point.
- Deferred: `apple-auth.ts` (needs an ES256 key fixture) and route-level
  `POST /auth/magic` coverage (lands with plan 008).
