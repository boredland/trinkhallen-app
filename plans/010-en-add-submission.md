# Plan 010: Let English-locale users submit a kiosk (and put `/add` under CSRF)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ea4c963..HEAD -- src/index.ts src/routes/api.submissions.tsx src/routes/csrf-coverage.test.ts src/routes/add-submission.test.ts tests/e2e/interactions.e2e.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / security
- **Planned at**: commit `ea4c963`, 2026-10-10

## Why this matters

The "suggest a kiosk" form exists at `/add` (German) and `/en/add` (English).
The English form posts to `/en/add`, but the POST handler is mounted only at the
root, so every English submission ends in **404 "Hier gibt's nix."** after the
user filled in the whole form. Verified in production:
`curl -X POST https://trinkhallen.app/en/add` → 404, while `POST /add` → 302.

Two smaller defects sit in the same handler:

- Its redirects ignore the locale (`/me?submitted=ok`, `/add?error=basics`), so
  even a fixed English submission would bounce the user to German pages.
- `POST /add` is the only state-changing endpoint outside the app's `csrf()`
  origin check (`src/index.ts:74-77` covers `/api/*`, `/me/*` and their `/en`
  twins only). The session cookie's `SameSite=Lax` blocks the classic attack,
  so this is defence in depth — but the repo applies that defence everywhere
  else on purpose.

## Current state

Files:

- `src/routes/api.submissions.tsx` (88 lines) — the POST handler.
- `src/index.ts` — CSRF mounts (lines 64-77) and route mounts (79-87, 139-145).
- `src/routes/pages.tsx:1334-1367` — `GET /add` renders the form (read-only
  context; **not modified**):

```tsx
  app.get("/add", async (c) => {
    const lang = langFromPath(c.req.path);
    const user = c.get("user");
    if (!user) return c.redirect(`${pathForLang("/me", lang)}?after=add`);
    …
        <form
          action={pathForLang("/add", lang)}
          method="post"
```

  `pages` is mounted at both `/` and `/en` (`src/index.ts:140-141`), so the
  English form's action is `/en/add`.

The handler, `src/routes/api.submissions.tsx:11-24, 71-74`:

```ts
apiSubmissions.post("/add", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/me?after=add");

  const form = await c.req.formData();
  const lat = parseFloat((form.get("lat") ?? "").toString());
  const lng = parseFloat((form.get("lng") ?? "").toString());
  const name = (form.get("name") ?? "").toString().trim();
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.redirect("/add?error=basics");
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return c.redirect("/add?error=coords");
  }
  …
  // Submissions sit in D1 with status='pending' until a moderator approves
  // on /moderate. Approval is what opens the PR — see lib/moderation.ts.
  return c.redirect("/me?submitted=ok");
});
```

Mounts, `src/index.ts:74-87`:

```ts
app.use("/api/*", csrf());
app.use("/en/api/*", csrf());
app.use("/me/*", csrf());
app.use("/en/me/*", csrf());

app.route("/", auth);
…
app.route("/", apiSubmissions);
app.route("/", moderate);
app.route("/", wellKnown);
```

and the existing comment at `src/index.ts:89-93`:

```ts
// … API/auth/moderation routes
// above stay root-only — the client passes the locale to them explicitly.
```

Locale helpers in `src/lib/messages.ts`:
`langFromPath(path)` → `"en"` for `/en` or `/en/...`, else `"de"` (lines 42-47);
`pathForLang(path, lang)` → adds/strips the `/en` prefix (lines 54-62). Example
of a handler that already localizes its redirect: `src/routes/pages.tsx:1660-1666`:

```ts
  app.post("/me/username", async (c) => {
    const me = pathForLang("/me", langFromPath(c.req.path));
    …
    return c.redirect(`${me}?username=${result}`);
```

The success banner the redirect targets is rendered by `/me` for both locales
from `?submitted=ok` (`src/routes/pages.tsx:1874-1877`), with copy in both
languages (`profile.flash.submitted`). The error banners on `/add` read
`?error=basics|coords` (`pages.tsx:1358-1362`) in both locales.

Test patterns:

- `src/routes/csrf-coverage.test.ts` — cross-origin POSTs through the full app
  with `const env = {} as never` and `redirect: "manual"`; asserts 403. Its
  table currently has four cases (moderate ban, reports; root and `/en`).
- `tests/e2e/interactions.e2e.ts:123-143` — Playwright: seeded session, fill
  `/add`, click `form[action="/add"] button[type="submit"]`, expect
  `/me?submitted=ok`.

**Hono request URLs in unit tests**: `app.request("/x")` builds the request as
`http://localhost/x` (`node_modules/hono/dist/hono-base.js:351`). `csrf()`
compares the `Origin` header with the request's own origin, so any test that
expects a *same-origin* POST to pass must use an absolute URL and a matching
`origin` header, e.g. `app.request("https://trinkhallen.app/en/add", { …, headers: { origin: "https://trinkhallen.app" } })`.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Typecheck | `bun run typecheck` | exit 0 |
| Focused   | `bun test src/routes/csrf-coverage.test.ts src/routes/add-submission.test.ts` | all pass |
| Tests     | `bun test` | all pass |
| Lint      | `bun run lint` | exit 0 |
| E2E       | `bun run test:e2e` | all pass (CI runs it; locally optional) |

## Scope

**In scope** (the only files you should modify):

- `src/index.ts`
- `src/routes/api.submissions.tsx`
- `src/routes/csrf-coverage.test.ts` (extend the table)
- `src/routes/add-submission.test.ts` (create)
- `tests/e2e/interactions.e2e.ts` (one new test)

**Out of scope** (do NOT touch):

- `src/routes/pages.tsx` — the form action `pathForLang("/add", lang)` is
  correct; the server was missing the route.
- The other "root-only" APIs (`/api/*`, `/auth/*`, moderation POSTs). They are
  posted to with absolute root paths, so they work in both locales.
- Validation rules, payload shape, the D1 insert, moderation.
- `public/sw.js` — `/add` and `/en/add` are already private paths there.
- The unused `?after=add` parameter on the login redirect (separate direction
  finding).

## Git workflow

- Branch: `advisor/010-en-add-submission`
- One commit: `fix(add): accept English kiosk submissions and CSRF-guard /add`
- Do NOT push or open a PR.

## Steps

### Step 1: Write failing tests

1. Extend `src/routes/csrf-coverage.test.ts` with two cases in the same style
   as the existing four:
   - `rejects cross-origin POST /add with 403`
   - `rejects cross-origin POST /en/add with 403`

2. Create `src/routes/add-submission.test.ts` for locale routing. It needs a
   logged-out request only (no D1): `attachUser` finds no session cookie and
   never touches `env.DB`, and the handler's first line redirects anonymous
   users. Use absolute URLs with a matching `origin` so the new `csrf()` mount
   lets them through:

```ts
import { describe, expect, it } from "bun:test";
import app from "../index";

const env = {} as never;
const ORIGIN = "https://trinkhallen.app";

function post(path: string) {
  return app.request(
    `${ORIGIN}${path}`,
    {
      method: "POST",
      redirect: "manual",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "name=x",
    },
    env,
  );
}

describe("POST /add locale routing", () => {
  it("routes the English form's POST /en/add to the submission handler", async () => {
    const r = await post("/en/add");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/en/me?after=add");
  });

  it("keeps the German POST /add redirecting to the German login", async () => {
    const r = await post("/add");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/me?after=add");
  });
});
```

**Verify**: `bun test src/routes/csrf-coverage.test.ts src/routes/add-submission.test.ts`
→ the two new csrf cases FAIL (no csrf on `/add` today: the request reaches
the handler and redirects with 302), and the `/en/add` routing case FAILS
(404). The German routing case passes already.

### Step 2: Localize the handler's redirects

In `src/routes/api.submissions.tsx`:

1. Import `langFromPath` and `pathForLang` from `"../lib/messages"`.
2. At the top of the handler compute
   `const lang = langFromPath(c.req.path);`.
3. Replace the four redirect targets:
   - `"/me?after=add"` → `` `${pathForLang("/me", lang)}?after=add` ``
   - `"/add?error=basics"` → `` `${pathForLang("/add", lang)}?error=basics` ``
   - `"/add?error=coords"` → `` `${pathForLang("/add", lang)}?error=coords` ``
   - `"/me?submitted=ok"` → `` `${pathForLang("/me", lang)}?submitted=ok` ``
4. Update the handler's doc comment (lines 6-10): it is mounted at both `/add`
   and `/en/add` so the form action stays human-shareable in either locale, and
   the redirects follow the request's locale.

`c.req.path` is the full request path (including `/en`) even inside a sub-app
mounted at `/en`; that is how `pages.tsx` handlers already detect the locale.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Mount the handler at `/en` and add CSRF

In `src/index.ts`:

1. After `app.use("/en/me/*", csrf());` (line 77), add:

```ts
app.use("/add", csrf());
app.use("/en/add", csrf());
```

   `csrf()` ignores GET/HEAD, so the `GET /add` form page is unaffected.
2. After `app.route("/en", moderate);` (line 145), add:

```ts
// The suggest-a-kiosk form posts to its own locale's URL (/en/add for
// English), so the submission handler needs the same twin mount as pages.
app.route("/en", apiSubmissions);
```

3. The comment at lines 89-93 says API routes "stay root-only". Amend it so it
   is true again, e.g. "…stay root-only (except the /add form handler, mounted
   per locale below)…".

**Verify**: `bun test src/routes/csrf-coverage.test.ts src/routes/add-submission.test.ts`
→ all pass (6 csrf cases + 2 routing cases).

### Step 4: Cover the real English flow end-to-end

In `tests/e2e/interactions.e2e.ts`, after the existing
`"submit a new kiosk via /add lands it in the moderation queue"` test (lines
123-143), add a copy for English:

- name: `"submit a new kiosk via /en/add stays in English and lands in the queue"`
- `page.goto("/en/add")`
- click `form[action="/en/add"] button[type="submit"]`
- expect URL `/\/en\/me\?submitted=ok$/`

Reuse `seedTestUser` / `setSessionCookie` / `deleteTestUser` exactly as the
German test does.

**Verify**: if Playwright is available locally, `bun run test:e2e` → all pass.
Otherwise state that the e2e runs in CI only.

### Step 5: Full suite

**Verify**: `bun run typecheck` → exit 0; `bun run lint` → exit 0;
`bun test` → all pass.

## Test plan

- `src/routes/csrf-coverage.test.ts`: +2 cases (cross-origin `POST /add`,
  `POST /en/add` → 403).
- `src/routes/add-submission.test.ts` (new): `/en/add` is routed and redirects
  to the English login; `/add` still redirects to the German login.
- `tests/e2e/interactions.e2e.ts`: +1 English happy-path submission.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck`, `bun run lint`, `bun test` all exit 0
- [ ] `grep -n 'app.route("/en", apiSubmissions)' src/index.ts` matches
- [ ] `grep -n 'app.use("/add", csrf())' src/index.ts` and
      `grep -n 'app.use("/en/add", csrf())' src/index.ts` both match
- [ ] `grep -nE 'redirect\("/(me|add)\?' src/routes/api.submissions.tsx` returns
      no matches (no hard-coded German redirects left)
- [ ] `git status --short` lists only in-scope files (plus `plans/README.md`)
- [ ] Mutation check: remove `app.route("/en", apiSubmissions)` → the `/en/add`
      routing test fails; restore. Report it.
- [ ] `plans/README.md` status row for 010 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `c.req.path` inside the `/en`-mounted handler does not include `/en` (the
  English test redirects to `/me?after=add`). Report instead of switching to
  parsing `c.req.url` by hand.
- Mounting `apiSubmissions` at `/en` shadows or breaks any `pages` route under
  `/en` (an existing test in `src/routes/lang-redirect.test.ts` fails).
- `csrf()` on `/add` rejects the same-origin POST in `add-submission.test.ts`
  even with the absolute URL and matching `origin` header.

## Maintenance notes

- **Invariant**: any form rendered by `pages` (mounted at `/` and `/en`) that
  posts to a locale-relative action needs its handler mounted at both prefixes
  *and* a `csrf()` mount for both. The csrf coverage table is the place to add
  each new pair.
- Moderation POSTs stay root-only on purpose — their forms post to absolute
  `/api/moderate/...` paths.
- Not addressed: after login, users land on `/me` rather than returning to
  `/add` (`?after=add` is set but never read). That is a product decision
  recorded as a direction option, not a bug fix.
