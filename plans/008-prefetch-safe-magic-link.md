# Plan 008: Make magic-link login survive mail-scanner prefetch

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ea4c963..HEAD -- src/routes/auth.tsx src/index.ts src/lib/messages.ts src/routes/magic-verify.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/007-auth-characterization-tests.md (must be DONE —
  its `magic.test.ts` pins `redeemMagicLink`, which this plan calls from a new
  place)
- **Category**: bug / security
- **Planned at**: commit `ea4c963`, 2026-10-10

## Why this matters

The login email contains a link to `GET /auth/magic/verify?token=…`. That GET
**immediately** burns the single-use token, creates the user row if missing,
and creates a 30-day session. Corporate mail-security products (Microsoft Safe
Links, Proofpoint, Mimecast) fetch every link in incoming mail before the human
sees it. The scanner's fetch wins the single-use race, so:

1. the real person clicks a few seconds later and gets "Der Login-Link ist
   abgelaufen oder schon verwendet" — they cannot log in; and
2. a `users` row and a `sessions` row exist for an address whose owner never
   did anything.

Production data shows this happening: of the 150 magic links redeemed in July
2026, **142 were consumed within 2 minutes of being minted** (78 in under 30
seconds), all for corporate addresses, and none of those 142 accounts ever did
anything.

The fix is the standard one: GET only renders a "Log in" confirmation page and
writes nothing; a POST from that page performs the redeem. Scanners fetch but do
not submit forms.

## Current state

Files:

- `src/routes/auth.tsx` (512 lines) — magic-link routes at lines 220-293;
  `upsertUserByEmail` at 355-375.
- `src/index.ts` — middleware: CSRF mounts at lines 64-77; route mounts 79-87.
- `src/lib/messages.ts` — i18n catalog: `DE` object (German, the default; the
  `MessageKey` type is `keyof typeof DE`, line 590) and `EN` object. The
  existing `"auth.login"` key is at line 295 (DE) and 548 (EN).
- `src/routes/pages.tsx:1544-1655` — `GET /me` renders the login page and the
  `?magic=sent|invalid|expired|robot` banners (lines 1566-1585). Read-only
  context; not modified.
- `src/routes/csrf-coverage.test.ts` — pattern for route-level tests through the
  full app.

The verify handler today, `src/routes/auth.tsx:283-293`:

```ts
auth.get("/auth/magic/verify", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.redirect("/me?magic=invalid");

  const result = await redeemMagicLink(c.env, token);
  if (!result) return c.redirect("/me?magic=expired");

  const userId = await upsertUserByEmail(c.env.DB, result.email);
  await createSession(c, userId);
  return c.redirect("/me");
});
```

How the link is built and mailed, `src/routes/auth.tsx:248-273` (unchanged by
this plan — the URL stays the same so links already in inboxes keep working):

```ts
    const origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
    const verifyUrl = `${origin}/auth/magic/verify?token=${encodeURIComponent(`${link.id}.${link.token}`)}`;
```

`redeemMagicLink` (`src/lib/magic.ts:59-90`) returns `{ email }` or `null`, and
its conditional `UPDATE … WHERE id = ? AND consumed_at IS NULL` makes it
single-use even under concurrency. It is correct; this plan only changes **when**
it is called.

CSRF today, `src/index.ts:64-77`:

```ts
// CSRF: Origin-header check on state-changing requests, as defence-in-depth
// alongside the SameSite=Lax session cookie. Scoped to the app's own POST
// surfaces (JSON/form APIs + the /me account actions) — deliberately NOT
// /auth/*, because Apple's sign-in callback is a legitimate cross-origin form
// POST and is guarded instead by its own state-cookie match. …
app.use("/api/*", csrf());
app.use("/en/api/*", csrf());
app.use("/me/*", csrf());
app.use("/en/me/*", csrf());
```

The new `POST /auth/magic/verify` is a state-changing request that logs the
browser in. Without an origin check, another site could auto-submit a token for
the *attacker's* account and silently log the victim into it (login CSRF). Hono's
`csrf()` is a no-op on GET/HEAD and accepts same-origin form posts
(`Sec-Fetch-Site: same-origin` or a matching `Origin`), so mounting it on this
one exact path is safe. It must **not** be widened to `/auth/*` (Apple).

Other facts the executor needs:

- `secureHeaders` already sends `Referrer-Policy: no-referrer` (observed on
  production responses), so the token in the GET URL does not leak via
  `Referer` from the confirm page.
- The service worker never caches `/auth/*` (`public/sw.js:43`,
  `PRIVATE_PATH_PREFIXES`). No SW change is needed.
- `/auth/*` routes are mounted at the root only; there is no `/en/auth/...`.
  Pick the page language with `resolveLang(c.req.header("accept-language"))`
  from `src/lib/messages.ts` (the login email itself is German-only).
- Rendering a full page: import `Layout` from `../components/Layout` and follow
  the shape `GET /me` uses (`src/routes/pages.tsx:1549-1558`):

```tsx
      return c.html(
        <Layout
          lang={lang}
          path={c.req.path}
          nonce={c.get("secureHeadersNonce")}
          title={t(lang, "auth.login")}
          noindex
          nav="me"
          user={undefined}
        >
          <section class="border-2 border-border bg-surface p-8"> … </section>
        </Layout>,
      );
```

  Reuse the `btn-neon` button class and the `border-2 border-border bg-surface
  p-8` section styling seen there. `auth.tsx` is already a `.tsx` file.

Repo conventions:

- Comments explain **why**. Keep the existing header comments' tone.
- i18n: every user-visible string goes through `t(lang, key)`; add keys to
  **both** `DE` and `EN`.
- Pre-commit runs biome, `tsc --noEmit`, `bun test`. Never `--no-verify`.

## Commands you will need

| Purpose   | Command                                    | Expected on success             |
|-----------|--------------------------------------------|---------------------------------|
| Typecheck | `bun run typecheck`                        | exit 0                          |
| Focused   | `bun test src/routes/magic-verify.test.ts` | all pass                        |
| Tests     | `bun test`                                 | all pass                        |
| Lint      | `bun run lint`                             | exit 0                          |
| E2E (CI)  | `bun run test:e2e`                         | all pass (needs Playwright; optional locally) |

## Scope

**In scope** (the only files you should modify):

- `src/routes/auth.tsx` — the verify route(s) only
- `src/index.ts` — one `csrf()` mount line plus comment
- `src/lib/messages.ts` — new `auth.magicConfirm.*` keys in `DE` and `EN`
- `src/routes/magic-verify.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/lib/magic.ts` — `redeemMagicLink` is correct; do not add a "peek"
  function. The confirm page deliberately does **no** database access, so a
  scanner GET costs nothing and reveals nothing (valid vs expired).
- The email body and the link URL format — links already sitting in inboxes
  must keep working.
- `upsertUserByEmail`'s check-then-insert race and the non-unique
  `users.email` column — separate findings, not this plan.
- `POST /auth/magic` (the "send me a link" form) and Turnstile.
- Any auto-submit JavaScript on the confirm page. A script that submits the
  form on load would let any JS-executing scanner log in again and defeat the
  fix.
- `src/routes/pages.tsx` — the `/me` banners already cover `invalid` and
  `expired`.

## Git workflow

- Branch: `advisor/008-prefetch-safe-magic-link`
- One commit: `fix(auth): confirm magic-link login with a POST so mail scanners can't burn it`
- Do NOT push or open a PR.

## Steps

### Step 1: Add the i18n keys

In `src/lib/messages.ts`, directly after `"auth.login": "Anmelden",` in `DE`
(line ~295), add:

```ts
  "auth.magicConfirm.title": "Einloggen bestätigen",
  "auth.magicConfirm.body":
    "Ein Klick noch: Bestätige, dass du dich bei trinkhallen.app einloggen willst.",
  "auth.magicConfirm.button": "▶ Jetzt einloggen",
```

and after `"auth.login": "Log in",` in `EN` (line ~548):

```ts
  "auth.magicConfirm.title": "Confirm login",
  "auth.magicConfirm.body": "One more click: confirm that you want to log in to trinkhallen.app.",
  "auth.magicConfirm.button": "▶ Log in now",
```

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Write the failing route tests

Create `src/routes/magic-verify.test.ts`. Drive the full app with
`app.request(path, init, env, ctx)` like `src/routes/csrf-coverage.test.ts`.

You need a D1 fake for the POST path. It must handle exactly these statements
(match on SQL substrings) and **throw on anything else**:

| SQL contains | method | answer |
|---|---|---|
| `SELECT email, token_hash, expires_at, consumed_at FROM magic_links WHERE id = ?` | `first` | the stored link row or `null` |
| `UPDATE magic_links SET consumed_at = ?` | `run` | set `consumed_at` if null; `{ meta: { changes: 1 \| 0 } }` |
| `SELECT id FROM users WHERE email = ?` | `first` | `null` (new user) or `{ id }` |
| `FROM retired_usernames` (the handle-free check) | `first` | `null` |
| `INSERT INTO users` | `run` | record it |
| `INSERT INTO sessions` | `run` | record it |

To seed a valid link without reimplementing hashing, call the real
`mintMagicLink(env, "a@example.com", {})` against the same fake first — so the
fake must also handle `SELECT COUNT(*) AS n FROM magic_links` (`first` → `{ n: 0 }`)
and `INSERT INTO magic_links` (`run` → store the 7 bound values as a row keyed by
the first value). Build the token string as `` `${id}.${token}` ``.

The env needs `DB`, `SESSION_SECRET: "test-secret"` and
`PUBLIC_ORIGIN: "https://trinkhallen.app"`. Pass an execution context as the
4th argument: `{ waitUntil() {}, passThroughOnException() {} }`.

Cases:

1. **GET writes nothing**: `GET /auth/magic/verify?token=<valid>` with an env
   whose `DB.prepare` throws → status 200, `content-type` contains `text/html`,
   body contains `method="post"` and `action="/auth/magic/verify"` and a hidden
   input with `name="token"` whose value is the token, `cache-control` contains
   `no-store`, and **no** `set-cookie` header.
2. GET without `token` → 302 to `/me?magic=invalid` (unchanged behaviour).
3. **POST redeems**: `POST /auth/magic/verify` with form body
   `token=<valid>` and header `origin: https://trinkhallen.app` → 302 to `/me`,
   a `set-cookie` containing `__Host-tk_sess=`, and the fake recorded one
   `INSERT INTO users` and one `INSERT INTO sessions`.
4. POST the same token again → 302 to `/me?magic=expired`, no new session.
5. POST with no `token` field → 302 to `/me?magic=invalid`.
6. **Login-CSRF guard**: POST with `origin: https://evil.example` → 403, and
   the link is still unconsumed (a follow-up same-origin POST succeeds).
7. A GET followed by a POST (the real human flow after a scanner's GET) →
   the POST still logs in. This is the regression case for the bug.

Build the form body with `new URLSearchParams({ token })` and set
`content-type: application/x-www-form-urlencoded`.

**Use absolute URLs for every request in this file**, e.g.
`app.request("https://trinkhallen.app/auth/magic/verify", …)`. A bare path
makes Hono build the request as `http://localhost/…`
(`node_modules/hono/dist/hono-base.js:351`), and `csrf()` compares the
`Origin` header with the request URL's own origin — so a bare path plus
`origin: https://trinkhallen.app` would be rejected as cross-origin and case 3
would 403 for the wrong reason. (The existing `csrf-coverage.test.ts` can use
bare paths only because every request there is *meant* to be rejected.)

**Verify**: `bun test src/routes/magic-verify.test.ts` → cases 1, 3, 6 and 7
FAIL today (GET redeems; there is no POST route). Cases 2 and 4-5 may fail too
because POST is unrouted — that is expected.

### Step 3: Split the route into GET (confirm) and POST (redeem)

In `src/routes/auth.tsx`, replace the handler at lines 283-293 with two
handlers. Target shape (adapt names, keep the comments' intent):

```tsx
// The emailed link only renders a confirmation page. Mail-security scanners
// (Safe Links, Proofpoint, Mimecast) GET every link in incoming mail; when GET
// redeemed the token, the scanner won the single-use race, the human got
// "expired", and an account + session existed for someone who never acted.
// Scanners fetch but don't submit forms, so the redeem moved to POST.
// No D1 access here on purpose: a scanner GET costs nothing and learns nothing.
auth.get("/auth/magic/verify", (c) => {
  const token = c.req.query("token");
  if (!token) return c.redirect("/me?magic=invalid");
  const lang = resolveLang(c.req.header("accept-language"));
  c.header("Cache-Control", "no-store");
  return c.html(
    <Layout lang={lang} path={c.req.path} nonce={c.get("secureHeadersNonce")}
            title={t(lang, "auth.magicConfirm.title")} noindex nav="me" user={undefined}>
      <section class="border-2 border-border bg-surface p-8">
        <h1 class="font-display text-3xl tracking-wide text-fg sm:text-4xl">
          {t(lang, "auth.magicConfirm.title")}
        </h1>
        <p class="mt-3 text-fg-muted">{t(lang, "auth.magicConfirm.body")}</p>
        <form action="/auth/magic/verify" method="post" class="mt-6">
          <input type="hidden" name="token" value={token} />
          <button type="submit" class="btn-neon">{t(lang, "auth.magicConfirm.button")}</button>
        </form>
      </section>
    </Layout>,
  );
});

auth.post("/auth/magic/verify", async (c) => {
  const token = ((await c.req.formData()).get("token") ?? "").toString();
  if (!token) return c.redirect("/me?magic=invalid");

  const result = await redeemMagicLink(c.env, token);
  if (!result) return c.redirect("/me?magic=expired");

  const userId = await upsertUserByEmail(c.env.DB, result.email);
  await createSession(c, userId);
  return c.redirect("/me");
});
```

Imports to add at the top of `auth.tsx`: `Layout` from `"../components/Layout"`
and `resolveLang`, `t` from `"../lib/messages"`. Hono JSX escapes the `value`
attribute, so the token cannot break out of the input.

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Protect the POST against login CSRF

In `src/index.ts`, after line 77 (`app.use("/en/me/*", csrf());`), add:

```ts
// The magic-link redeem logs the browser in, so a cross-site auto-submit could
// sign a victim into an attacker's account. Exact path only — the rest of
// /auth/* stays exempt for Apple's cross-origin callback.
app.use("/auth/magic/verify", csrf());
```

Also extend the existing comment block above (lines 64-69) by one clause so it
no longer says `/auth/*` is wholly exempt, e.g. "…deliberately NOT /auth/*
(except the magic-link redeem below), because Apple's…".

**Verify**: `bun test src/routes/magic-verify.test.ts` → all 7 pass.

### Step 5: Full suite

**Verify**:
- `bun run typecheck` → exit 0
- `bun run lint` → exit 0
- `bun test` → all pass, including plan 007's `src/lib/magic.test.ts`
- If Playwright is available: `bun run test:e2e` → all pass (no e2e touches
  `/auth/magic/verify` today, so this guards against collateral damage only)

### Step 6: Smoke through the real Worker in dev (recommended)

The dev server cannot deliver mail and D1 stores only token hashes, so you
cannot get a live link from the UI. Smoke the routes with an **invalid but
well-formed** token instead — that exercises the real Worker, middleware chain
and rendering without minting anything. Do **not** add logging of `verifyUrl`
or tokens anywhere, even temporarily.

With `bun run dev` running (it serves `https://localhost:5173`, self-signed):

1. `curl -sk -D - -o /tmp/confirm.html 'https://localhost:5173/auth/magic/verify?token=deadbeef.cafe'`
   → `HTTP/… 200`, a `cache-control: no-store` header, **no** `set-cookie`
   header, and `/tmp/confirm.html` contains `action="/auth/magic/verify"`.
2. `curl -sk -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST -H 'origin: https://localhost:5173' --data 'token=deadbeef.cafe' https://localhost:5173/auth/magic/verify`
   → `302 …/me?magic=expired` (unknown id → redeem returns null).
3. Same as 2 with `-H 'origin: https://evil.example'` → `403`.
4. Open the step-1 URL in a browser and click the button → you land on `/me`
   with the red "abgelaufen" banner.

Report the output of each command. If you cannot run dev, say so; the unit
tests are the gate. The full happy path (a real emailed link) is verified by
the operator after deploy — see Maintenance notes.

## Test plan

New file `src/routes/magic-verify.test.ts`, 7 cases listed in Step 2: GET is
read-only and cache-proof, GET/POST input validation, POST happy path,
single-use on replay, cross-origin rejection, and the GET-then-POST flow that
reproduces the original bug. Pattern: `src/routes/csrf-coverage.test.ts`
(app-level requests) and plan 007's `src/lib/magic.test.ts` (stateful
`magic_links` fake).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun test` exits 0; `src/routes/magic-verify.test.ts` has 7 passing tests
- [ ] `grep -n 'auth.get("/auth/magic/verify"' src/routes/auth.tsx` shows a
      handler that contains neither `redeemMagicLink` nor `createSession`
      (read the handler body to confirm)
- [ ] `grep -n 'auth.post("/auth/magic/verify"' src/routes/auth.tsx` matches
- [ ] `grep -n 'app.use("/auth/magic/verify", csrf())' src/index.ts` matches
- [ ] `grep -n 'app.use("/auth/\*"' src/index.ts` returns no match (CSRF not
      widened to Apple's callback)
- [ ] `git diff ea4c963 -- src/routes/auth.tsx | grep -c '^+.*console\.'`
      prints `0` (no logging added; tokens must never reach logs)
- [ ] `git status --short` lists only the four in-scope files (plus
      `plans/README.md`)
- [ ] Mutation check: temporarily make the GET handler call
      `redeemMagicLink` again → case 1 or case 7 fails. Revert. Report it.
- [ ] `plans/README.md` status row for 008 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 007 is not DONE (no `src/lib/magic.test.ts`).
- Rendering `Layout` from `auth.tsx` creates an import cycle or type error you
  cannot resolve without touching `Layout.tsx` or `pages.tsx`.
- `csrf()` on the exact path rejects the same-origin POST in tests (case 3
  fails with 403 even with a matching `origin` header).
- You find a second consumer of `GET /auth/magic/verify` that depends on it
  setting a session (e.g. the iOS/Android wrapper deep-linking to it). Search
  `ios/`, `android/`, and `tests/` for `magic/verify` before Step 3; report any
  hit.
- The verify URL format would have to change.

## Maintenance notes

- **Invariant**: `GET /auth/magic/verify` must stay free of side effects and
  database access. Anything that "improves" it by redeeming on GET, or by
  auto-submitting the form with JavaScript, brings the scanner bug back. Test
  case 1 guards this (the env's DB throws on any access).
- The confirm page cannot say *which* address is logging in, because that would
  need a DB read on GET. That is a deliberate trade-off; revisit only with a
  read-only lookup that leaks nothing to an unauthenticated GET.
- Existing accounts created by scanners in July 2026 are handled separately
  (plan 012). This plan only stops new ones.
- **Post-deploy check (operator)**: request a login link to a real mailbox,
  open it, confirm the page shows the "Einloggen bestätigen" button, click it,
  and land on `/me` logged in. Then confirm the unit tests' claim in
  production: `curl -sI '<the link>'` returns `cache-control: no-store` and no
  `set-cookie`. Use a fresh link for the curl — the clicked one is consumed.
- Watch in review: the hidden input carries the raw token; confirm the page is
  `no-store` and that `Referrer-Policy: no-referrer` is still sent by
  `secureHeaders` (it is the Hono default; nobody has overridden it in
  `src/index.ts:24-60`).
