# Plan 002: Stop the service worker caching `/en` auth-sensitive pages

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 498bbb5..HEAD -- public/sw.js`
> If `public/sw.js` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (shares a root cause with plan 001 but touches no shared file)
- **Category**: security
- **Planned at**: commit `498bbb5`, 2026-08-16

## Why this matters

The service worker deliberately refuses to cache per-user and auth-sensitive
pages: `/me`, `/moderate`, `/add`, `/auth`. The comment in the code explains
exactly why — a stale-while-revalidate snapshot of those pages flashes the wrong
session state on the first paint after any login/logout transition. This was a
real bug that a previous SW version bump was issued to fix.

That guard matches on absolute path prefixes. But page routes are mounted at
both `/` and `/en` (`src/index.ts:135-140`), so the English equivalents —
`/en/me`, `/en/moderate`, `/en/add` — do **not** match any prefix in the list.
They fall through to `navigationWithOfflineFallback`, which caches the SSR HTML
in `tk-runtime-v8`. An English-locale user therefore gets exactly the bug the
guard exists to prevent: their profile page, or a moderator's queue, cached and
re-served from disk after logout or an account switch.

After this plan, the guard is locale-aware, and a test pins it so a future
locale can't reopen the hole.

## Current state

Files:

- `public/sw.js` — the service worker. Plain JS, no build step, served as a
  static asset. Contains a `VERSION` constant that invalidates all caches.
- `src/index.ts` — shows the double mount that creates the gap (read-only
  context for you; do not modify it in this plan).

The guard list, `public/sw.js:37-43`:

```js
const TILES_HOSTS = new Set(["tiles.openfreemap.org"]);
const STATIC_PATH_PREFIXES = ["/assets/", "/favicon.svg", "/apple-touch-icon.svg"];
// Per-user / auth-sensitive paths — never cache these. The HTML differs
// per session (logged-in chrome, profile data, moderation queue) and a
// stale-while-revalidate snapshot would flash the wrong state on the
// first paint after any auth transition.
const PRIVATE_PATH_PREFIXES = ["/me", "/moderate", "/add", "/auth"];
```

Where it is applied, `public/sw.js:145-154`:

```js
  if (req.mode === "navigate") {
    if (
      url.origin === self.location.origin &&
      PRIVATE_PATH_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))
    ) {
      return; // pass through to the network
    }
    event.respondWith(navigationWithOfflineFallback(req));
    return;
  }
```

Note the matcher already handles both the exact path (`/me`) and the subtree
(`/me/...`). Your change must preserve both behaviours for the prefixed locale
too: `/en/me` and `/en/me/...` must both bypass.

The cache version constant, `public/sw.js:29`:

```js
const VERSION = "v8";
```

The locale prefix that creates the second URL space, `src/lib/messages.ts:20-23`:

```ts
export const DEFAULT_LANG: Lang = "de";
export const SUPPORTED_LANGS: readonly Lang[] = ["de", "en"];
/** Languages other than the default get a URL path prefix (e.g. /en/...). */
export const PREFIXED_LANGS: readonly Exclude<Lang, typeof DEFAULT_LANG>[] = ["en"];
```

`public/sw.js` is plain JS served verbatim — it **cannot** import from
`src/lib/messages.ts`. The locale prefix has to be duplicated as a literal in
the SW, so leave a comment tying it back to `PREFIXED_LANGS` as the source of
truth.

Repo conventions:

- Comments explain **why**. The existing SW comments are a good model — they
  state the failure mode being prevented, not the mechanics.
- Per `AGENTS.md`: "Any change to the cache strategy or the cached URL set must
  bump [`VERSION`]". Changing which URLs bypass the cache **is** a change to the
  cached URL set, and users already carrying poisoned `/en/me` entries need the
  old cache dropped. The bump is mandatory here, not optional.
- Client-side tests live beside the source in `src/client/` and use
  `@happy-dom/global-registrator` — see `src/client/sw-update.test.ts:1-20`.

## Commands you will need

| Purpose   | Command             | Expected on success        |
|-----------|---------------------|----------------------------|
| Install   | `bun install`       | exit 0                     |
| Typecheck | `bun run typecheck` | exit 0, no output          |
| Tests     | `bun test`          | all pass (114 before this plan) |
| Lint      | `bun run lint`      | exit 0, "No fixes applied" |

## Scope

**In scope** (the only files you should modify):

- `public/sw.js`
- `src/client/sw-private-paths.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/index.ts` — the CSRF twin of this bug is plan 001's job.
- `public/_headers` — asset cache headers are a separate mechanism and are
  correct today; `/sw.js` is already `max-age=0, must-revalidate` there.
- The install-time precache list at `public/sw.js:55-67` — it warms `/` and
  `/about`, both public. Adding `/en` equivalents is a separate judgement call
  about offline coverage, not a security fix.
- `src/client/sw-update.ts` and its test — the update-prompt flow is unrelated.

## Git workflow

- Branch: `advisor/002-sw-private-paths-en`
- One commit. Message style from `git log`: `security: nonce-based CSP, drop
  script-src 'unsafe-inline'` is the closest precedent. Use:
  `security(sw): bypass cache for /en auth-sensitive paths, bump to v9`
- Do NOT push or open a PR.

## Steps

### Step 1: Extract the matcher into a testable, exported-in-test-only helper

`public/sw.js` runs in a ServiceWorker global scope and is not importable by the
test runner as-is. Rather than restructure the worker, define the matcher as a
standalone named function near the constants so the test can reproduce it
exactly from a single source of truth.

Concretely, in `public/sw.js`:

1. Keep `PRIVATE_PATH_PREFIXES` as the locale-neutral list — do **not** hand-write
   `/en/me`, `/en/moderate`, … into it. Hardcoding the cross-product means the
   next locale silently reopens the hole, which is the exact failure this plan
   exists to close.
2. Add a `LOCALE_PREFIXES` constant listing the URL prefixes that mirror the
   default-locale routes (today: `["/en"]`), with a comment naming
   `PREFIXED_LANGS` in `src/lib/messages.ts` as the source of truth and stating
   that `public/sw.js` cannot import from `src/` so it must be kept in sync by
   hand.
3. Add a function `isPrivatePath(pathname)` that strips a leading locale prefix
   if present, then applies the existing exact-or-subtree match against
   `PRIVATE_PATH_PREFIXES`.

The stripping must be precise: `/en/me` → `/me`, `/en` → `/`, `/english` must
**not** be treated as locale-prefixed (guard on the boundary — the segment ends
at a `/` or at end-of-string, exactly like the existing matcher does).

Then replace the inline `.some(...)` condition at `public/sw.js:146-149` with a
call to `isPrivatePath(url.pathname)`, keeping the `url.origin` check.

**Verify**: `bun run lint` → exit 0. (Biome lints `public/sw.js` — it is in the
93 files it checks.)

### Step 2: Bump the SW cache version

Change `VERSION` at `public/sw.js:29` from `"v8"` to `"v9"`.

This is required, not cosmetic: the `activate` handler at `public/sw.js:71-83`
deletes every `tk-` cache not in the current `ALL_CACHES` set, so bumping the
version is what evicts any already-poisoned `/en/me` entries from users who
visited before the fix. Without the bump, existing clients keep serving the
stale cached HTML.

Update the trailing comment on that constant if it names the old version.

**Verify**: `grep -n 'const VERSION' public/sw.js` → shows `"v9"`.

### Step 3: Write the regression test

Create `src/client/sw-private-paths.test.ts`.

The SW cannot be imported directly (it references `self`, `caches`, and
`ServiceWorkerGlobalScope` at module load). Instead, read `public/sw.js` as text
and evaluate just the matcher in isolation — this keeps the test bound to the
real source rather than a copy that can drift.

Target approach:

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// public/sw.js is plain JS served verbatim to the browser — it can't be
// imported (it touches `self`/`caches` at load). Slice out the pure matcher
// and its constants so the assertions run against the shipped source, not a
// hand-copied duplicate that would drift.
const source = readFileSync("public/sw.js", "utf8");
```

Extract the `PRIVATE_PATH_PREFIXES`, `LOCALE_PREFIXES`, and `isPrivatePath`
declarations from `source` and evaluate them with `new Function(...)` to obtain
a callable `isPrivatePath`. If the extraction finds nothing, the test must fail
loudly with a clear message rather than silently passing.

Cases to assert, one `it()` each:

Must be treated as private (bypass the cache) — `true`:
- `/me`, `/me/`, `/moderate`, `/add`, `/auth/google`
- `/en/me`, `/en/moderate`, `/en/add`, `/en/auth/google` ← the regression
- `/en/me/` (trailing slash under a locale prefix)

Must **not** be treated as private (still cacheable) — `false`:
- `/`, `/about`, `/en`, `/en/about`, `/stadt/frankfurt`, `/k/tk_fr_0001`
- `/english` and `/mendoza` — boundary cases proving prefix matching does not
  match on a bare substring. `/mendoza` starting with `/me` is the exact trap
  the existing exact-or-subtree matcher was written to avoid; keep it covered.

**Verify**: `bun test src/client/sw-private-paths.test.ts` → all pass.

### Step 4: Confirm the whole suite is green

**Verify**:
- `bun run typecheck` → exit 0
- `bun run lint` → exit 0
- `bun test` → all pass; 114 + your new tests

## Test plan

- New file `src/client/sw-private-paths.test.ts` covering the three groups in
  Step 3: default-locale private paths, `/en`-prefixed private paths (the
  regression), and public/boundary paths that must stay cacheable.
- Structural pattern: `src/client/sw-update.test.ts` for placement and
  file-header-comment style. You do **not** need `GlobalRegistrator` here —
  there is no DOM in this test, only a pure function.
- Verification: `bun test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun test` exits 0, all tests passing
- [ ] `grep -n 'const VERSION' public/sw.js` shows `"v9"`
- [ ] `grep -n 'isPrivatePath' public/sw.js` shows both the definition and its
      use inside the `req.mode === "navigate"` branch
- [ ] `grep -n '"/en/me"' public/sw.js` returns **no** matches (the cross-product
      must not be hardcoded)
- [ ] `git status --short` lists only `public/sw.js` and
      `src/client/sw-private-paths.test.ts` (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `PRIVATE_PATH_PREFIXES` no longer exists in `public/sw.js`, or the navigate
  branch has been restructured — the plan's excerpts are stale.
- `VERSION` is already above `"v8"` — someone shipped an SW change since this
  plan was written; report the current value and what changed.
- You cannot extract the matcher for the test without restructuring the worker's
  runtime behaviour. Report it rather than refactoring the SW's control flow —
  a slightly awkward test is much cheaper than a reworked service worker.
- The `/mendoza` or `/english` boundary case fails after your change: your
  prefix-stripping is matching on a bare substring instead of a path segment.
  Fix the boundary check; do not delete the test case.

## Maintenance notes

- **The rule this encodes**: `public/sw.js` cannot import from `src/`, so
  `LOCALE_PREFIXES` is a hand-maintained mirror of `PREFIXED_LANGS`
  (`src/lib/messages.ts:23`). Adding a locale means updating both, and the test
  in this plan is what will catch a forgotten update — extend its case list when
  a locale is added.
- Per `AGENTS.md`, any future change to the cached URL set must bump `VERSION`
  again. A reviewer should reject an SW cache-behaviour change that leaves the
  version untouched, because existing clients keep the old cache otherwise.
- Plan 001 fixes the same locale-blind-spot class in the CSRF middleware. If you
  are reviewing this, confirm both landed — they are independent files but the
  same underlying mistake.
- Deliberately deferred: adding `/en/` equivalents to the install-time precache
  list (`public/sw.js:55-67`). That is an offline-coverage improvement, not a
  security fix, and bundling it here would muddy the change.
