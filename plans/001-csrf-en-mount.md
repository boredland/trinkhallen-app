# Plan 001: Extend CSRF protection to the `/en` locale mount

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 498bbb5..HEAD -- src/index.ts src/routes/moderate.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `498bbb5`, 2026-08-16

## Why this matters

The app mounts its page routes and the moderation sub-app at **two** paths: the
root (German, the default locale) and `/en` (English). The `csrf()` middleware
was mounted per-path and only covers `/api/*`, `/me/*`, and `/en/me/*` — the
`/en/api/*` glob was never added. Because the moderation sub-app is routed at
`/en` as well, every privileged moderation POST is reachable at a second URL
where the Origin check does not run.

Concretely: `POST /api/moderate/users/:id/ban` is CSRF-protected, but
`POST /en/api/moderate/users/:id/ban` hits the exact same handler with no Origin
check. The only remaining defence is the `SameSite=Lax` session cookie. This was
verified empirically against the real middleware stack: a cross-origin POST to
the root path returns 403, the identical POST under `/en` returns 200.

After this plan, both mount points enforce the same Origin check, and a
regression test pins it so the next locale added can't silently reopen the hole.

## Current state

Files:

- `src/index.ts` — app entry: middleware, route mounting, locale prefixing.
- `src/routes/moderate.tsx` — moderation queue page + the privileged decision
  endpoints. Exports the `moderate` Hono sub-app.

The CSRF mounting today, `src/index.ts:64-72`:

```ts
// CSRF: Origin-header check on state-changing requests, as defence-in-depth
// alongside the SameSite=Lax session cookie. Scoped to the app's own POST
// surfaces (JSON/form APIs + the /me account actions) — deliberately NOT
// /auth/*, because Apple's sign-in callback is a legitimate cross-origin form
// POST and is guarded instead by its own state-cookie match. csrf() is a no-op
// on safe methods, so mounting it on these globs leaves GETs untouched.
app.use("/api/*", csrf());
app.use("/me/*", csrf());
app.use("/en/me/*", csrf());
```

The double mount that creates the gap, `src/index.ts:135-140`:

```ts
app.route("/", pages);
app.route("/en", pages);
// The moderation page is fully localized, so expose it per-locale too (keeps the
// header language switcher from dead-ending on /en). Its form POSTs stay at the
// root /api/moderate endpoints.
app.route("/en", moderate);
```

The sub-app's own route registrations, `src/routes/moderate.tsx:15-20`:

```ts
export const moderate = new Hono<{ Bindings: Env }>();

// ── role gate ───────────────────────────────────────────────────────────────

moderate.use("/moderate", requireModerator);
moderate.use("/api/moderate/*", requireModerator);
```

Note the role gate at `moderate.tsx:19-20` is registered **inside** the sub-app,
so it applies under both mounts correctly. Only the CSRF middleware — registered
on the outer `app` with absolute globs — has the locale blind spot. Keep that
asymmetry in mind: the fix belongs where the other CSRF mounts live, in
`index.ts`, not in the sub-app.

Repo conventions to follow:

- Comments explain **why**, not what (see `.github`-adjacent house style and the
  existing CSRF comment above, which justifies the `/auth/*` exclusion).
- Tests live beside the code (`src/routes/lang-redirect.test.ts` tests
  `src/index.ts` middleware). Match that placement and style.
- The existing middleware test `src/routes/lang-redirect.test.ts:13-17` shows the
  pattern for exercising the real app with a stub env:

```ts
const env = {} as never;

function req(path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers, redirect: "manual" }, env);
}
```

## Commands you will need

| Purpose   | Command             | Expected on success        |
|-----------|---------------------|----------------------------|
| Install   | `bun install`       | exit 0                     |
| Typecheck | `bun run typecheck` | exit 0, no output          |
| Tests     | `bun test`          | all pass (114 before this plan) |
| Lint      | `bun run lint`      | exit 0, "No fixes applied" |

## Scope

**In scope** (the only files you should modify):

- `src/index.ts`
- `src/routes/csrf-coverage.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/routes/moderate.tsx` — the role gate there is already locale-correct.
  Adding a second CSRF mount inside the sub-app would double-apply the check
  under the root mount.
- `src/routes/auth.tsx` and the `/auth/*` paths — the CSRF exclusion there is
  deliberate and documented (Apple's cross-origin form POST is guarded by a
  state-cookie match instead). Do not add `csrf()` to `/auth/*`.
- `public/sw.js` — it has a related `/en` blind spot, but that is plan 002's job.
- Any change to `pathForLang` / `PREFIXED_LANGS` in `src/lib/messages.ts`.

## Git workflow

- Branch: `advisor/001-csrf-en-mount`
- One commit for the fix + test. Message style is a mix of conventional commits
  and plain imperative subjects; recent examples from `git log`:
  `feat(auth): gate magic-link signup behind Turnstile`, `Handle missing kiosks
  in report approval`. Use: `security: extend csrf() to the /en API mount`
- Do NOT push or open a PR.

## Steps

### Step 1: Write the failing regression test

Create `src/routes/csrf-coverage.test.ts`. It must exercise the **real** app
from `src/index.ts` so it covers the actual middleware mounting, not a
reconstruction.

The test asserts that a cross-origin POST is rejected at both the root and the
`/en` mount. Use a request with an `origin` header that differs from the request
URL's host — that is what `csrf()` checks. Model the file header comment and the
`req()` helper on `src/routes/lang-redirect.test.ts:1-17`.

Target shape:

```ts
import { describe, expect, it } from "bun:test";
import app from "../index";

const env = {} as never;

function crossOriginPost(path: string) {
  return app.request(
    path,
    { method: "POST", headers: { origin: "https://evil.example" }, redirect: "manual" },
    env,
  );
}
```

Cover at minimum these cases, one `it()` each:

1. `POST /api/moderate/users/u1/ban` from a foreign origin → status 403.
2. `POST /en/api/moderate/users/u1/ban` from a foreign origin → status 403.
   **This is the case that currently fails.**
3. `POST /api/reports` from a foreign origin → status 403.
4. `POST /en/api/reports` from a foreign origin → status 403.

Explain in a file-level comment *why* the `/en` cases exist: the pages and
moderation sub-apps are mounted at both `/` and `/en`, so any absolute-glob
middleware needs a per-locale twin or it silently covers only one URL for the
same handler.

**Verify**: `bun test src/routes/csrf-coverage.test.ts` → the two `/en` cases
FAIL with `Expected: 403, Received: <not 403>`; the two root cases PASS. If the
`/en` cases already pass, STOP — the vulnerability is already fixed and this
plan is stale.

### Step 2: Mount `csrf()` on the `/en` API glob

In `src/index.ts`, add the missing mount next to the existing three at lines
70-72, and extend the existing comment block to record *why* the locale twins
exist (so the next person adding a locale knows the rule). The `/en/me/*` mount
already present is the precedent — you are completing the set, not inventing a
pattern.

The result should mount `csrf()` on `/en/api/*` in addition to the current three
globs.

Do not reorder or remove any existing mount. Do not touch the `/auth/*`
exclusion or its comment justification.

**Verify**: `bun test src/routes/csrf-coverage.test.ts` → all 4 tests pass.

### Step 3: Confirm nothing else regressed

The CSRF middleware is a no-op on safe methods, so GETs are unaffected — but the
full suite proves it, including the locale-redirect tests that also drive
`src/index.ts`.

**Verify**:
- `bun run typecheck` → exit 0
- `bun run lint` → exit 0
- `bun test` → all pass; total is 114 + the 4 new tests = 118

## Test plan

- New file `src/routes/csrf-coverage.test.ts` with the 4 cases in Step 1:
  root-mount ban rejected, `/en`-mount ban rejected (the regression),
  root-mount reports rejected, `/en`-mount reports rejected.
- Structural pattern to follow: `src/routes/lang-redirect.test.ts` — same
  `app.request(path, init, env)` shape, same `redirect: "manual"`, same
  explanatory file-level comment.
- Verification: `bun test` → all pass, including 4 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun test` exits 0 with 118 tests passing
- [ ] `src/routes/csrf-coverage.test.ts` exists and its `/en` cases assert 403
- [ ] `grep -c ', csrf());' src/index.ts` returns 4 (three existing mounts plus
      `/en/api/*`; this pattern matches only the `app.use(...)` mount lines, not
      the two comments that also mention `csrf()`)
- [ ] `git status --short` lists only `src/index.ts` and
      `src/routes/csrf-coverage.test.ts` (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `/en` test cases pass **before** you make the Step 2 change — the code has
  drifted and this plan's premise is void.
- `src/index.ts` no longer mounts `moderate` at `/en` (line 140 in the excerpt),
  which would mean the exposure was closed a different way.
- Adding the `/en/api/*` mount breaks any existing test — that would suggest a
  legitimate cross-origin POST surface exists under `/en` that this plan did not
  account for. Report which test and what it asserts.
- You find yourself wanting to add `csrf()` to `/auth/*` to make something pass.

## Maintenance notes

- **The general rule this fixes**: any middleware mounted on the outer `app`
  with an absolute path glob needs a twin for every prefixed locale in
  `PREFIXED_LANGS` (`src/lib/messages.ts:23`). Today that is just `en`. Adding a
  third locale means auditing every `app.use("/...")` call in `src/index.ts`.
  A reviewer should scrutinise exactly that on any locale addition.
- The sibling blind spot in `public/sw.js` (`PRIVATE_PATH_PREFIXES` lacks `/en`
  variants) is the same root cause and is handled by plan 002. If you are
  reviewing this change, check that 002 also landed.
- Deliberately **not** done here: converting the per-path mounts into a single
  regex mount. It would be terser but would make the `/auth/*` exclusion much
  harder to read, and that exclusion is load-bearing for Apple sign-in.
