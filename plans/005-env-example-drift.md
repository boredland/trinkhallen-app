# Plan 005: Realign `.env.example` and the secrets docs with the code

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 498bbb5..HEAD -- .env.example src/env.d.ts wrangler.toml AGENTS.md public/sw.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `498bbb5`, 2026-08-16

## Why this matters

`.env.example` is the onboarding contract: the README tells a new contributor to
`cp .env.example .dev.vars` and start working. It has drifted from what the code
actually reads.

- It lists **`GITHUB_WEBHOOK_SECRET`**, which is read nowhere in the repo. It is
  a leftover from the runtime `/api/sync` webhook that was deliberately removed
  (recorded in the data repo's decision log, 2026-05-20). A contributor either
  hunts for a value that has no purpose, or assumes the file is authoritative
  and trusts the rest of it.
- It **omits** all four `APPLE_SIGN_IN_*` variables and `TURNSTILE_SECRET_KEY`,
  which the code does read. Following the README verbatim therefore produces a
  dev environment where Apple sign-in returns a 503 and the Turnstile bot gate
  silently disables itself — and the second one is the dangerous half, because
  `verifyTurnstile` returns `true` when the secret is absent. A developer can
  easily believe they have tested the bot gate when they have bypassed it.

Two smaller doc drifts travel with this: `wrangler.toml`'s secrets comment omits
the Apple variables, and `AGENTS.md` states the service worker `VERSION` is v5
when it is v8.

After this plan, `.env.example` matches `src/env.d.ts` exactly, and a test keeps
them in sync.

## Current state

Files:

- `.env.example` — 19 lines, copied to `.dev.vars` (gitignored) for local dev.
- `src/env.d.ts` — the authoritative `Env` interface: bindings, vars, secrets.
- `wrangler.toml` — production vars plus a comment listing the secrets.
- `AGENTS.md` — the load-bearing-facts doc.
- `README.md:67-102` — the one-time operator setup block.

`.env.example` in full:

```
# Copy to .dev.vars (gitignored) for local `wrangler dev`.
# Production values go in `wrangler secret put <KEY>`.

# 32+ random bytes (`openssl rand -hex 32`) — signs session cookies
SESSION_SECRET=

# Google OAuth — https://console.cloud.google.com/apis/credentials
# Redirect URI: http://localhost:8787/auth/google/callback for local dev
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# GitHub App for opening PRs against trinkhallen-data on user submissions
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
GITHUB_WEBHOOK_SECRET=

# Public site origin used to build OAuth redirect URIs and absolute links
PUBLIC_ORIGIN=http://localhost:8787
```

The authoritative interface, `src/env.d.ts:4-28`:

```ts
export interface Env {
  // Bindings
  DB: D1Database;
  ASSETS: Fetcher;
  EMAIL: SendEmail;

  // Vars
  PUBLIC_ORIGIN: string;
  TURNSTILE_SITE_KEY: string;
  /** Verified Email Routing destination; unset disables report emails. */
  REPORT_NOTIFY_TO: string;

  // Secrets — some may be empty in dev / before operator setup
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  APPLE_SIGN_IN_SERVICES_ID: string;
  APPLE_SIGN_IN_TEAM_ID: string;
  APPLE_SIGN_IN_KEY_ID: string;
  APPLE_SIGN_IN_PRIVATE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
}
```

The fail-open behaviour that makes the missing Turnstile entry worth calling
out, `src/lib/turnstile.ts:27-33`:

```ts
export async function verifyTurnstile(
  env: { TURNSTILE_SECRET_KEY?: string },
  token: string | null,
  remoteIp: string | null,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
```

This fail-open is **deliberate and documented** at `src/lib/turnstile.ts:13-15`
("An empty TURNSTILE_SECRET_KEY disables the gate, so local dev and any deploy
predating the secret keep working"). Do not change it. The fix is to make the
variable visible in `.env.example` with a comment stating the consequence of
leaving it blank.

`wrangler.toml:49-52`:

```toml
# Secrets (set via `wrangler secret put`):
#   SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
#   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID,
#   TURNSTILE_SECRET_KEY
```

`AGENTS.md:37-40` (the stale version claim):

```
- **`public/sw.js`** has a `VERSION` constant (v5 today). Any change to
  the cache strategy or the cached URL set must bump it.
```

`public/sw.js:29` actually reads `const VERSION = "v8";`.

**Security handling rule for this plan**: `.env.example` is committed. Every
value in it must stay **empty** or be a non-secret local default (like the
existing `PUBLIC_ORIGIN=http://localhost:8787`). Never paste a real credential
into it — not from your environment, not from `.dev.vars`, not from anywhere.
If you happen to encounter a live credential while working, do not copy it into
any file; report its location and credential type only.

Repo conventions:

- `.env.example` groups related variables under a `#` comment explaining what
  the group is for and where to obtain it. Match that shape.
- Comments explain **why** / what breaks without it.

## Commands you will need

| Purpose   | Command             | Expected on success        |
|-----------|---------------------|----------------------------|
| Install   | `bun install`       | exit 0                     |
| Typecheck | `bun run typecheck` | exit 0, no output          |
| Tests     | `bun test`          | all pass (114 before this plan) |
| Lint      | `bun run lint`      | exit 0, "No fixes applied" |

## Scope

**In scope** (the only files you should modify):

- `.env.example`
- `wrangler.toml` (comment block only)
- `AGENTS.md` (the one stale version number)
- `src/env-example.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/env.d.ts` — it is the source of truth and is correct. `.env.example`
  moves to match it, never the reverse.
- `src/lib/turnstile.ts` — the fail-open when the secret is absent is
  deliberate and documented. Do not make it fail closed here.
- `wrangler.toml`'s actual `[vars]` values — `TURNSTILE_SITE_KEY` is a public
  sitekey by design and `REPORT_NOTIFY_TO` is an operator address. Only the
  secrets **comment** changes.
- `README.md` — its operator block already documents the Apple secrets
  correctly (lines 89-92). Adding `TURNSTILE_SECRET_KEY` there would be nice
  but is not required; if you do add it, keep it to one line in the existing
  `wrangler secret put` list.
- `.dev.vars` — gitignored, may hold real values. Do not read it, do not modify
  it, do not copy anything out of it.

## Git workflow

- Branch: `advisor/005-env-example-drift`
- One commit. Message style from `git log`: `chore: drop unused alpinejs +
  htmx.org deps`. Use: `docs(dx): realign .env.example with Env, drop dead
  webhook secret`
- Do NOT push or open a PR.

## Steps

### Step 1: Confirm `GITHUB_WEBHOOK_SECRET` really is dead

Do not delete on my word — verify.

**Verify**: `grep -rn 'GITHUB_WEBHOOK_SECRET' --include='*.ts' --include='*.tsx' --include='*.toml' --include='*.yml' --include='*.md' . | grep -v node_modules`
→ the only match is `.env.example:16`. If anything else references it, STOP.

### Step 2: Rewrite `.env.example`

Bring it in line with `src/env.d.ts`:

1. Remove `GITHUB_WEBHOOK_SECRET`.
2. Add the four `APPLE_SIGN_IN_*` variables as an empty group, with a comment
   pointing at the README's setup steps (`README.md:81-92`) rather than
   duplicating them, and noting that leaving them blank makes `/auth/apple`
   return 503 — which is fine for local dev that does not exercise Apple login.
3. Add `TURNSTILE_SECRET_KEY` (empty) with a comment stating plainly that an
   empty value **disables** the bot gate on `/auth/magic`, so the gate cannot be
   tested locally without a real key. This is the entry whose absence is
   actively misleading today.
4. Add `TURNSTILE_SITE_KEY` and `REPORT_NOTIFY_TO`. These are `[vars]` in
   production rather than secrets, but `wrangler dev` reads `.dev.vars` for
   them too, and both are declared on `Env`. Group them under a comment
   distinguishing them from the secrets above — for `REPORT_NOTIFY_TO`, note
   that an unset value disables report notification mails.

Keep every value empty except a non-secret local default where one genuinely
helps (as `PUBLIC_ORIGIN` already does).

**Verify**: `grep -c '^[A-Z_]*=' .env.example` → 14.

`Env` declares 17 members; 3 are bindings (`DB`, `ASSETS`, `EMAIL`) wired by
`wrangler.toml` rather than `.dev.vars`, leaving 14 that belong in
`.env.example`: `PUBLIC_ORIGIN`, `TURNSTILE_SITE_KEY`, `REPORT_NOTIFY_TO`,
`SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`,
`APPLE_SIGN_IN_SERVICES_ID`, `APPLE_SIGN_IN_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID`,
`APPLE_SIGN_IN_PRIVATE_KEY`, `TURNSTILE_SECRET_KEY`.

The file has 8 keys today: 7 survive, `GITHUB_WEBHOOK_SECRET` is removed, and 7
are added (4 Apple + `TURNSTILE_SECRET_KEY` + `TURNSTILE_SITE_KEY` +
`REPORT_NOTIFY_TO`).

### Step 3: Add the drift test

Create `src/env-example.test.ts`. It parses both `src/env.d.ts` and
`.env.example` and asserts they agree, so this drift cannot silently return.

Approach: read both files as text. From `src/env.d.ts`, extract the member names
of the `Env` interface. From `.env.example`, extract the keys matching
`/^([A-Z][A-Z0-9_]*)=/m`. Then assert:

1. Every `Env` member that is **not** a binding appears as a key in
   `.env.example`. Bindings (`DB`, `ASSETS`, `EMAIL`) are wired by
   `wrangler.toml`, not by `.dev.vars` — exclude them explicitly by name, with a
   comment saying why.
2. Every key in `.env.example` appears as a member of `Env` — this is the half
   that catches a dead entry like `GITHUB_WEBHOOK_SECRET`.

Make failures diagnostic: report the offending names, not just a boolean. A
future contributor should see "missing from .env.example: FOO" rather than
`expected true to be false`.

Add a file-header comment explaining why the test exists: `.env.example` is the
onboarding contract, and a silently missing `TURNSTILE_SECRET_KEY` disables a
security control without any signal.

**Verify**: `bun test src/env-example.test.ts` → all pass. Then temporarily add
a junk line `BOGUS_KEY=` to `.env.example`, re-run, confirm it **fails**, and
remove the junk line. (A drift test that cannot fail is worthless — prove it.)

### Step 4: Fix the two doc drifts

1. `wrangler.toml:49-52` — add the four `APPLE_SIGN_IN_*` names to the secrets
   comment so it lists every secret the code reads.
2. `AGENTS.md:38` — change "(v5 today)" to "(v8 today)".

If plan 002 has already landed and bumped the SW to v9, write v9 instead. Check
`grep -n 'const VERSION' public/sw.js` and use whatever it actually says.

**Verify**:
- `grep -n 'APPLE_SIGN_IN' wrangler.toml` → matches in the comment block
- The version in `AGENTS.md` matches `grep -n 'const VERSION' public/sw.js`

### Step 5: Full suite

**Verify**:
- `bun run typecheck` → exit 0
- `bun run lint` → exit 0
- `bun test` → all pass; 114 + your new tests

## Test plan

- New file `src/env-example.test.ts`: bidirectional key-set comparison between
  the `Env` interface and `.env.example`, with binding names excluded and
  diagnostic failure messages.
- Deliberate negative check in Step 3 (add a junk key, confirm the test fails,
  remove it) to prove the test has teeth.
- Structural pattern: `src/lib/notify.test.ts` for the plain
  `describe`/`it`/`expect` layout without DOM or mocks.
- Verification: `bun test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun test` exits 0, all tests passing
- [ ] `grep -rn 'GITHUB_WEBHOOK_SECRET' --include='*.ts' --include='*.tsx' --include='*.toml' --include='*.md' . | grep -v node_modules`
      returns no matches
- [ ] `grep -c 'APPLE_SIGN_IN' .env.example` returns 4
- [ ] `grep -n 'TURNSTILE_SECRET_KEY' .env.example` returns a match
- [ ] Every value in `.env.example` is empty or a localhost default — no
      credential material anywhere in the file
- [ ] The SW version in `AGENTS.md` matches `public/sw.js`
- [ ] `git status --short` lists only `.env.example`, `wrangler.toml`,
      `AGENTS.md`, `src/env-example.test.ts` (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 005 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `GITHUB_WEBHOOK_SECRET` turns out to be referenced somewhere real (Step 1) —
  it is not dead and must not be removed.
- `src/env.d.ts`'s `Env` interface has gained or lost members since the excerpt
  above — re-derive the expected key list from the live file and note the
  difference in your report.
- The drift test cannot distinguish bindings from vars/secrets without
  hardcoding the three binding names. Hardcoding them **with an explanatory
  comment** is the accepted answer here; do not build an AST parser for this.
- You are tempted to put a real value into `.env.example` to make something
  work. Never do this — report the blocker instead.

## Maintenance notes

- **The contract this creates**: `src/env.d.ts` is the single source of truth
  for environment shape. Adding a member to `Env` now requires adding a key to
  `.env.example`, and the test in this plan enforces it. A reviewer seeing an
  `Env` change without a `.env.example` change should expect a red test.
- Bindings are excluded from that check by name. If a fourth binding is added
  (a queue, a KV namespace), the exclusion list in the test needs it too — the
  failure message should make that obvious.
- Deliberately **not** changed: Turnstile's fail-open when the secret is unset.
  It is a documented tradeoff that keeps local dev and pre-secret deploys
  working. If you ever want it fail-closed in production only, that is a real
  change with a real risk (a misconfigured deploy would break all magic-link
  signups) and deserves its own decision, not a drive-by.
