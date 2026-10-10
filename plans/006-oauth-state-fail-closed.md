# Plan 006: Reject Google OAuth callbacks that carry no `state`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ea4c963..HEAD -- package.json bun.lock src/routes/auth.tsx src/routes/oauth-state.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ea4c963`, 2026-10-10

## Why this matters

Google sign-in uses the `googleAuth` middleware from `@hono/oauth-providers`.
The installed version (0.6.2) only compares the callback's `state` query
parameter with the `state` cookie **when both exist**: if an attacker strips
`state` from the callback URL and the victim has no `state` cookie, both values
are `undefined`, they compare equal, and the check passes (advisory
GHSA-fm3f-ch8h-qw8q, fixed in 0.8.6: "fail closed on missing OAuth state").

In this app that is an account-takeover path, not just login CSRF. The callback
handler has a **link mode**: when the visitor already has a session, the Google
identity from the callback is attached to *their* account without any
confirmation. An attacker completes Google consent with their own Google account,
copies the callback URL without `state`, and gets a logged-in user (moderator
included) to open it. The attacker's Google identity is now linked to the
victim's account; the attacker then signs in with Google as the victim.

After this plan, a callback without a matching `state` is rejected with 401,
and a test pins that.

## Current state

Files:

- `package.json` — line 29: `"@hono/oauth-providers": "^0.6.0",`. The caret
  range on a `0.x` version pins the minor, so `bun update` alone will **not**
  move past 0.6.x; the range itself must change.
- `bun.lock` — resolves `@hono/oauth-providers@0.6.2`.
- `src/routes/auth.tsx` — Google SSO routes. Lines 21, 46-115 are relevant.
- `src/routes/csrf-coverage.test.ts` — structural pattern for a route-level test
  that drives the whole Hono app with `app.request(...)` and an empty env.

The vulnerable check in the installed library,
`node_modules/@hono/oauth-providers/dist/providers/google/index.js:174-188`:

```js
    if (!auth.code) {
      (0, import_cookie.setCookie)(c, "state", newState, { maxAge: 60 * 10, httpOnly: true, path: "/" });
      return c.redirect(auth.redirect());
    }
    if (c.req.url.includes("?")) {
      const storedState = (0, import_cookie.getCookie)(c, "state");
      if (c.req.query("state") !== storedState) {
        throw new import_http_exception2.HTTPException(401);
      }
    }
    await auth.getUserData();
```

The fixed check in 0.9.0 (`dist/google/index.mjs:113-117`, verified by reading
the published tarball):

```js
    if (auth.code) {
      const storedState = getCookie(c, "state");
      const state = c.req.query("state");
      if (!storedState || !state || state !== storedState) throw new HTTPException(401);
    }
```

0.9.0 also sets the `state` cookie with `secure: true, sameSite: "Lax"`. The
`googleAuth` options, the `"user-google"` context variable and its
`verified_email` field are unchanged between 0.6.2 and 0.9.0. The upstream
changelog for 0.7.0-0.9.0 lists only new providers and fixes — no breaking
change to the Google provider.

How the app wires it, `src/routes/auth.tsx:46-73`:

```ts
auth.use("/auth/google", async (c, next) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text(/* 503 "not yet configured" */, 503);
  }
  const handler = googleAuth({
    client_id: c.env.GOOGLE_CLIENT_ID,
    client_secret: c.env.GOOGLE_CLIENT_SECRET,
    scope: ["openid", "email"],
    redirect_uri: callbackUrl(c, c.req.url),
  });
  return handler(c, next);
});

auth.use("/auth/google/callback", async (c, next) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text("Google SSO is not configured.", 503);
  }
  const handler = googleAuth({ /* same options */ });
  return handler(c, next);
});
```

The link-mode branch that turns this into account takeover,
`src/routes/auth.tsx:84-103`:

```ts
  // Already logged in and starting Google OAuth from /me → link mode. …
  if (currentUser) {
    const outcome = await linkGoogleToCurrentUser(c.env.DB, {
      userId: currentUser.id,
      googleSub: profile.id,
      googleEmail: profile.email,
    });
    if (outcome === "conflict") {
      return c.redirect("/me?link=conflict");
    }
    return c.redirect("/me?link=ok");
  }
```

`src/index.ts:64-69` deliberately does **not** mount `csrf()` on `/auth/*`
(Apple's callback is a legitimate cross-origin POST), so nothing else in the
app catches this.

Repo conventions:

- Comments explain **why**, not what (see the existing comment above the Apple
  state check at `src/routes/auth.tsx:162-163`).
- Tests use `bun:test` (`describe`/`it`/`expect`) and live next to the code
  (`src/routes/*.test.ts`). Route tests call `app.request(path, init, env)`
  with `redirect: "manual"`; see `src/routes/csrf-coverage.test.ts:15-23`.
- The pre-commit hook (lefthook) runs biome, `tsc --noEmit`, and `bun test`.
  Never pass `--no-verify`.

## Commands you will need

| Purpose   | Command                                   | Expected on success                  |
|-----------|-------------------------------------------|--------------------------------------|
| Install   | `bun install`                             | exit 0                               |
| Typecheck | `bun run typecheck`                       | exit 0, no output after the `$ tsc` line |
| Focused   | `bun test src/routes/oauth-state.test.ts` | all pass                             |
| Tests     | `bun test`                                | all pass (149 before this plan)      |
| Lint      | `bun run lint`                            | exit 0, "No fixes applied"           |
| Audit     | `bun audit 2>&1 \| grep -c oauth-providers` | `0`                                |

## Scope

**In scope** (the only files you should modify):

- `package.json` (the `@hono/oauth-providers` range only)
- `bun.lock` (regenerated by `bun install`)
- `src/routes/oauth-state.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/routes/auth.tsx` — the library upgrade fixes the defect; no app code
  change is needed. Do not hand-roll a second state check alongside the
  library's (two checks drifting apart is how this class of bug comes back).
  The one exception is the STOP condition below.
- The Apple flow (`/auth/apple*`) — it has its own correct state-cookie check
  (`src/routes/auth.tsx:162-168`).
- `src/index.ts` csrf mounts — `/auth/*` is excluded on purpose.
- Any other dependency. Do not run `bun update` without arguments; do not touch
  `hono`, `maplibre-gl`, or dev dependencies — those are separate decisions.

## Git workflow

- Branch: `advisor/006-oauth-state-fail-closed`
- One commit. Message style from `git log` (conventional, scoped):
  `security(auth): fail closed on missing Google OAuth state`
- Do NOT push or open a PR.

## Steps

### Step 1: Write the failing regression test

Create `src/routes/oauth-state.test.ts`. It drives the full app the same way
`csrf-coverage.test.ts` does, but needs an env with Google credentials so the
middleware runs instead of returning 503. Use dummy strings.

`globalThis.fetch` is replaced with a stub that records calls and answers like
Google's token endpoint does for a bad code. That keeps the test offline and
lets it assert the real invariant: a rejected callback never reaches the token
exchange.

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../index";

/**
 * Login-CSRF / forced-account-linking guard for Google sign-in.
 *
 * The callback's `state` must match the `state` cookie set when the flow
 * started. A callback that omits both used to pass (undefined === undefined),
 * which let an attacker link their Google identity to a logged-in victim via
 * the link-mode branch in auth.tsx.
 */

const env = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  PUBLIC_ORIGIN: "https://trinkhallen.app",
} as never;

const realFetch = globalThis.fetch;
let fetched: string[] = [];

beforeEach(() => {
  fetched = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return Response.json({ error: "invalid_grant", error_description: "Bad Request" });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function callback(query: string, cookie?: string) {
  return app.request(
    `/auth/google/callback?${query}`,
    { redirect: "manual", headers: cookie ? { cookie } : {} },
    env,
  );
}

describe("Google OAuth callback state check", () => {
  it("rejects a callback with a code but no state and no state cookie", async () => {
    const r = await callback("code=attacker-code");
    expect(r.status).toBe(401);
    expect(fetched).toEqual([]);
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const r = await callback("code=c&state=abc", "state=xyz");
    expect(r.status).toBe(401);
    expect(fetched).toEqual([]);
  });

  it("rejects a callback with a state param but no state cookie", async () => {
    const r = await callback("code=c&state=abc");
    expect(r.status).toBe(401);
    expect(fetched).toEqual([]);
  });

  it("starts the flow by redirecting to Google and setting a state cookie", async () => {
    const r = await app.request("/auth/google", { redirect: "manual" }, env);
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toStartWith("https://accounts.google.com/");
    expect(r.headers.get("set-cookie") ?? "").toContain("state=");
  });
});
```

Notes for this step:

- `attachUser` runs on every request (`src/index.ts:62`) and reads the session
  cookie; with no session cookie it never touches `env.DB`, so the minimal env
  is enough. If a test fails with a `DB`-related TypeError instead of a status
  mismatch, that is a STOP condition (the middleware order changed).
- `app.onError` (`src/index.ts:148-155`) passes `HTTPException`s through via
  `err.getResponse()`, so the library's 401 reaches the test as a 401.
- Why the first test discriminates: in 0.6.2 a callback without `state` skips
  the check and calls `getTokenFromCode()`, which POSTs to
  `https://oauth2.googleapis.com/token`; on an `error` response it throws
  `HTTPException(400)` (`node_modules/@hono/oauth-providers/dist/providers/google/index.js:113-130`).
  So 0.6.2 yields **400 with one recorded fetch**; 0.9.x yields **401 with
  none**.

**Verify**: `bun test src/routes/oauth-state.test.ts` → the **first** test
FAILS against 0.6.2 (status 400, `fetched` contains the token URL). The other
three already pass — they pin behaviour that must survive the upgrade.

### Step 2: Upgrade the library

Edit `package.json` line 29 from `"@hono/oauth-providers": "^0.6.0",` to
`"@hono/oauth-providers": "^0.9.0",`, then run `bun install`.

**Verify**:
- `bun install` → exit 0
- `grep -n '"@hono/oauth-providers@' bun.lock` → shows `0.9.0` (or a later
  `0.9.x`), not `0.6.2`
- `bun audit 2>&1 | grep -c oauth-providers` → `0`

### Step 3: Confirm the app still compiles against the new types

The import `import { googleAuth } from "@hono/oauth-providers/google";`
(`src/routes/auth.tsx:21`) must still resolve; 0.9.0 exports `./google`.

**Verify**: `bun run typecheck` → exit 0. If it fails on `c.get("user-google")`
or `profile.verified_email`, STOP (the plan assumed those types are unchanged).

### Step 4: Run the regression test and the full suite

**Verify**:
- `bun test src/routes/oauth-state.test.ts` → 4 pass
- `bun test` → all pass (149 + 4)
- `bun run lint` → exit 0

### Step 5: Manual smoke (local dev, optional but recommended)

If `.dev.vars` in your environment has Google credentials, run `bun run dev`,
open `https://localhost:5173/auth/google` and confirm you are redirected to
Google's consent screen. Do not attempt a full login unless the operator set
this up for you. Skip this step without failing the plan if credentials are
absent.

## Test plan

New file `src/routes/oauth-state.test.ts`, four cases:

1. Callback with `code` and neither `state` param nor cookie → 401 (the
   advisory's exact scenario; fails before the fix).
2. Mismatched `state` vs cookie → 401.
3. `state` param present, cookie absent → 401.
4. Flow start redirects to `accounts.google.com` and sets a `state` cookie
   (proves the upgrade did not break the happy-path entry).

Structural pattern: `src/routes/csrf-coverage.test.ts`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun test` exits 0; `src/routes/oauth-state.test.ts` has 4 passing tests
- [ ] `grep -n '"@hono/oauth-providers": "\^0.9' package.json` matches
- [ ] `bun audit 2>&1 | grep -c oauth-providers` prints `0`
- [ ] `git status --short` lists only `package.json`, `bun.lock`,
      `src/routes/oauth-state.test.ts` (plus `plans/README.md`)
- [ ] Mutation check: temporarily set `package.json` back to `^0.6.0`, run
      `bun install && bun test src/routes/oauth-state.test.ts` → test 1 fails;
      restore `^0.9.0` and `bun install` again. Report that you did this.
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `bun install` pulls in a different `hono` major or changes any dependency
  other than `@hono/oauth-providers` in `bun.lock` beyond its own transitive
  deps. Report the diff.
- `bun run typecheck` fails anywhere in `src/routes/auth.tsx` after the upgrade.
- Test 1 still fails after the upgrade (the published fix does not cover this
  path). In that case the fallback is an app-side check in `auth.tsx` that
  mirrors the Apple flow's `if (!expected || form.state !== expected)` — but do
  not write it; report first.
- A test hangs, or reaches the real network (the fetch stub was bypassed —
  e.g. the library captured `fetch` at import time). Report rather than adding
  a network-dependent test.

## Maintenance notes

- **Invariant**: the Google callback must reject any request whose `state`
  query param is missing, empty, or different from the `state` cookie. The
  regression test is the guard; keep it when touching auth.
- The link-mode branch in `auth.tsx:84-103` still links without asking the user
  to confirm. With state enforced this is safe (only a flow the same browser
  started can complete), but a future change that adds another entry point into
  link mode must keep that property.
- 0.9.0 sets the `state` cookie with `secure: true`. Local dev already runs over
  HTTPS (`@vitejs/plugin-basic-ssl` in `vite.config.ts`), so this does not break
  `bun run dev`. If someone switches dev to plain HTTP, Google login will fail
  with 401 there.
- Deferred: `hono` itself is behind 16 advisories, only one on a used code path
  and latent. Bump it in its own change so a rendering regression cannot hide
  inside this security fix.
