# Plan 012: Delete the 142 bot accounts from the July 2026 magic-link campaign

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **This plan touches production data.** The executor writes and tests the
> script against **local** D1 only. The production run is performed by the
> operator (a human), using the exact commands in Step 6, after reviewing the
> dry-run output. An executor must never pass `--remote --apply`.
>
> **Drift check (run first)**: `git diff --stat ea4c963..HEAD -- scripts/purge-bot-accounts.ts migrations/`
> A new migration that changes `users`, `sessions`, `magic_links`, or any table
> with a `user_id` column is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: MED (irreversible delete in production; mitigated by a dry run, a
  JSON backup, and D1 Time Travel)
- **Depends on**: plans/008-prefetch-safe-magic-link.md should be DONE and
  deployed first, so no new scanner-created accounts appear after the purge.
  Not a hard dependency.
- **Category**: data hygiene / privacy
- **Planned at**: commit `ea4c963`, 2026-10-10

## Why this matters

Between 2026-07-02 and 2026-07-24 a bot submitted harvested corporate email
addresses to the magic-link form from datacenter IPs (recorded in
`src/lib/turnstile.ts:3-7`). 640 login mails went out. 142 links were then
redeemed within seconds by the recipients' mail scanners, each creating a user
row and a session. The operator shadow-banned all 142 on 2026-08-09.

They are harmless to the site but they are **personal data of people who never
signed up** (email addresses, plus IP and user-agent on each magic-link row),
retained indefinitely. The operator decided to delete them. This plan provides a
reviewable, idempotent one-off script with a dry-run default and a backup.

## Current state

Production facts measured on 2026-10-10 (read-only queries):

| Fact | Value |
|---|---|
| All users | 153 |
| Cohort matching the predicate below | **142** (created 2026-07-02 08:48 → 2026-07-24 20:26 UTC) |
| Cohort's ratings / check-ins / reports / submissions / field signals / anomalies | **0 / 0 / 0 / 0 / 0 / 0** |
| Cohort's `sessions` rows | 149 |
| `magic_links` rows for cohort emails | 150 |
| `magic_links` minted in the window for emails with **no** user row (never redeemed) | 489 |
| `magic_links` in the window for a remaining real user | 1 (must be kept) |
| The deleted-account sentinel `00000000-0000-0000-0000-000000000000` | exists, `google_sub` not `email:%`, not banned — excluded by the predicate |
| `retired_usernames` rows | 0 |

**Cohort predicate** (all must hold), epoch bounds: 2026-07-01T00:00Z =
`1782864000`, 2026-07-27T00:00Z = `1785110400`:

```sql
SELECT id, email, username FROM users
 WHERE google_sub LIKE 'email:%'          -- created via magic link, never linked Google/Apple
   AND role = 'user'
   AND banned_at IS NOT NULL               -- operator shadow-banned them
   AND created_at >= 1782864000 AND created_at < 1785110400
   AND id NOT IN (SELECT user_id FROM ratings
                  UNION SELECT user_id FROM checkins
                  UNION SELECT user_id FROM reports
                  UNION SELECT user_id FROM submissions
                  UNION SELECT user_id FROM field_signals)
```

Live schema (from `sqlite_master` in production) — foreign keys to `users(id)`:

| Table | Column | On delete |
|---|---|---|
| `sessions` | `user_id` | CASCADE |
| `ratings` | `user_id` | CASCADE |
| `checkins` | `user_id` | CASCADE |
| `field_signals` | `user_id` | CASCADE |
| `user_anomalies` | `user_id` | CASCADE (`reviewed_by` has no ON DELETE) |
| `reports` | `user_id` | **no action** — a row would block the delete |
| `submissions` | `user_id` | **no action** — a row would block the delete |
| `magic_links` | — | no FK; joined by `email` |

The cohort owns no `reports`/`submissions` rows (predicate guarantees it), so the
delete cannot hit an FK error. Do not rely on CASCADE: delete child rows
explicitly, the same way the app's own account deletion does
(`src/routes/pages.tsx:1689-1719`):

```ts
  await db.prepare(`DELETE FROM reports WHERE user_id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM submissions WHERE user_id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM ratings WHERE user_id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM checkins WHERE user_id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
  await db.prepare(`DELETE FROM magic_links WHERE email = ?`).bind(email).run();
  // 3. Finally the users row itself.
  await db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
```

**Usernames**: each bot was auto-assigned a themed handle. `retired_usernames`
exists to stop a freed public handle from being re-claimed by someone else
(`src/lib/usernames.ts:186-195`). Bot handles were never public in any
meaningful way (no contributions), so this plan does **not** retire them —
retiring 142 random handles would only shrink the generator's pool. If the
operator prefers to retire them, it is a one-line change noted in Step 3.

### The repo's one-off script convention — `scripts/backfill-usernames.ts`

```ts
/**
 * One-off backfill for the username auto-generation migration (0012).
 * …
 *   bun scripts/backfill-usernames.ts            # local D1
 *   bun scripts/backfill-usernames.ts --remote   # production D1
 *
 * Idempotent: a re-run is a no-op once every user already has a handle.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = "trinkhallen-prod";
const LOCATION = process.argv.includes("--remote") ? "--remote" : "--local";

function query<T = Record<string, unknown>>(sql: string): T[] {
  const out = execFileSync("bunx", ["wrangler", "d1", "execute", DB, LOCATION, "--json", "--command", sql], { encoding: "utf8" });
  // wrangler prepends banner/notice lines to stdout; the --json payload is the
  // array that starts at the first bracket.
  const start = out.indexOf("[");
  const parsed = JSON.parse(start === -1 ? "[]" : out.slice(start)) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

function runFile(sql: string): void {
  const file = join(mkdtempSync(join(tmpdir(), "tk-backfill-")), "backfill.sql");
  writeFileSync(file, sql);
  execFileSync("bunx", ["wrangler", "d1", "execute", DB, LOCATION, "--file", file], { stdio: "inherit" });
}
```

Interpolation note from that script: `// Handles are [a-z0-9_] and ids are UUIDs,
so direct interpolation is safe.` This plan must **not** interpolate emails
into SQL (emails can contain `'`). Delete by user id (UUIDs) and by a subquery,
never by a literal email.

Existing backups from previous one-off operations live **outside** the repo in
`/home/jonass/Documents/trinkhallen/_db-backup/` (e.g.
`orphan-repoint-20260816.json`). Follow that convention; never write a backup
containing emails into the repo.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Local schema | `bun run db:migrate:local` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 (note: `scripts/` is outside `tsconfig.json`'s `include`, so also run the next row) |
| Script syntax | `bun build scripts/purge-bot-accounts.ts --target=bun --outdir=/tmp/tk-purge-check` | exit 0; then delete `/tmp/tk-purge-check` |
| Lint | `bun run lint` | exit 0 |
| Dry run (local) | `bun scripts/purge-bot-accounts.ts` | prints a plan, writes nothing |

## Scope

**In scope**:

- `scripts/purge-bot-accounts.ts` (create)

**Out of scope** (do NOT touch):

- Any `src/` file, any migration, `AGENTS.md`.
- Production D1. The executor never runs anything with `--remote` other than
  what Step 6 assigns to the operator.
- The 3 orphan `magic_links` rows **outside** the July window and the one
  in-window link belonging to a real user.
- General TTL cleanup of expired sessions/links for real users — separate
  finding (an hourly cron sweep), not this plan.

## Git workflow

- Branch: `advisor/012-purge-july-bot-accounts`
- One commit: `chore(scripts): one-off purge of the July 2026 bot accounts`
- Do NOT push or open a PR.

## Steps

### Step 1: Script skeleton with a dry-run default

Create `scripts/purge-bot-accounts.ts`, modelled on
`scripts/backfill-usernames.ts` (reuse its `query`/`runFile` helpers verbatim,
changing only the temp-dir prefix to `tk-purge-`). Flags:

- `--remote` → target production (default: `--local`)
- `--apply` → actually delete (default: dry run — print what would happen,
  write nothing)

Header comment must state: what the cohort is and why it is being deleted
(link `src/lib/turnstile.ts:3-7` for the campaign), the four usage lines
(local dry run, local apply, remote dry run, remote apply), that it is
idempotent, and that the operator must capture a D1 Time Travel bookmark before
`--remote --apply`.

**Verify**: `bun build … --outdir=/tmp/tk-purge-check` → exit 0.

### Step 2: Select and sanity-check the cohort

1. Run the **cohort predicate** above (constants `WINDOW_START = 1782864000`,
   `WINDOW_END = 1785110400` with a comment giving the ISO dates).
2. Hard guards — print a clear message and `process.exit(1)` if any fails:
   - cohort size is greater than 142 (the cohort can only shrink, e.g. after a
     partial earlier run; it can never grow because the window is in the past);
   - any cohort id equals `00000000-0000-0000-0000-000000000000`;
   - the count of `users` **not** in the cohort, after the purge, would be
     below 11 (the real users). Compute it as
     `SELECT COUNT(*) FROM users` minus the cohort size.
3. Print: cohort size; first/last `created_at` as ISO; counts of
   `sessions` rows for the cohort and of `magic_links` that Step 3 will delete;
   and the **email domains only** (`substr(email, instr(email,'@')+1)`),
   grouped and counted. **Never print full email addresses** — the run output
   ends up in terminals and logs.

**Verify** (local): on a fresh local DB the cohort is empty → the script prints
`0 accounts match — nothing to do.` and exits 0.

### Step 3: Backup, then delete in one batch

Only when `--apply` is set:

1. Write a backup JSON to
   `/home/jonass/Documents/trinkhallen/_db-backup/bot-purge-<YYYYMMDD>.json`
   — or, if that directory does not exist on the machine running the script, to
   `os.tmpdir()` — containing the full cohort `users` rows plus their
   `sessions` and `magic_links` rows (`SELECT *`). Print the path. Never write
   into the repository. Abort if the write fails.
2. Build one SQL file and run it with `runFile`. **Do not assume the file is
   atomic** and do **not** wrap it in `BEGIN`/`COMMIT` — D1's remote file
   import rejects explicit transactions (Cloudflare docs, "Import and export
   data"; wrangler 4.94.0 here). The statement order below is chosen so that
   stopping after *any* statement leaves a consistent database that a re-run
   finishes: child rows go first, the `users` delete comes after its children,
   and the cohort predicate still matches any user not yet deleted. Delete by
   **id list** (UUIDs, validated with `/^[0-9a-f-]{36}$/i` before
   interpolation; abort on any mismatch) and by subquery, in this order:

```sql
DELETE FROM sessions        WHERE user_id IN (<ids>);
DELETE FROM user_anomalies  WHERE user_id IN (<ids>);
DELETE FROM field_signals   WHERE user_id IN (<ids>);
DELETE FROM magic_links     WHERE email IN (SELECT email FROM users WHERE id IN (<ids>));
DELETE FROM users           WHERE id IN (<ids>);
DELETE FROM magic_links
 WHERE created_at >= 1782864000 AND created_at < 1785110400
   AND consumed_at IS NULL
   AND email NOT IN (SELECT email FROM users);
```

   The last statement removes the 489 never-redeemed links the bot minted for
   addresses that never got an account. It runs **after** the users delete so
   `email NOT IN (SELECT email FROM users)` already excludes every remaining
   real user, and `consumed_at IS NULL` keeps any redeemed link.

   No `ratings`/`checkins`/`reports`/`submissions` deletes: the predicate
   guarantees there are none, and Step 4 re-checks it right before deleting.

   (If the operator asks to retire the bot handles, add
   `INSERT OR IGNORE INTO retired_usernames (username, retired_at) SELECT lower(username), <now> FROM users WHERE id IN (<ids>) AND username IS NOT NULL;`
   **before** the users delete. Default: do not.)

3. After the batch, re-run the cohort predicate and print the remaining count
   (expected 0) and `SELECT COUNT(*) FROM users` (expected 11 in production).

### Step 4: Re-check contributions immediately before deleting

Right before building the SQL in Step 3, query
`SELECT COUNT(*) AS n FROM (<the five-table UNION>) WHERE user_id IN (<ids>)` —
if `n > 0`, abort without deleting. (The predicate already filters these, but a
contribution could appear between the select and the delete.)

### Step 5: Prove it locally end-to-end

1. `bun run db:migrate:local`.
2. Seed a local fixture with `bunx wrangler d1 execute trinkhallen-prod --local --file <tmp.sql>`
   containing, with fake `@example.test` addresses:
   - 3 cohort users (magic-link sub, banned, `created_at` inside the window),
     each with 1 session and 1 consumed magic link;
   - 1 user identical to the cohort but with one `ratings` row (must survive);
   - 1 unbanned magic-link user inside the window (must survive);
   - 1 banned magic-link user created **outside** the window (must survive);
   - 2 unconsumed magic links in the window for emails with no user (must go);
   - 1 unconsumed magic link in the window for a surviving user (must stay);
   - the sentinel user `00000000-0000-0000-0000-000000000000` — already
     inserted locally by `migrations/0008_delete_ban.sql` (`google_sub =
     'deleted:sentinel'`); just confirm it exists before and after.

   Put the fixture SQL in a temp file outside the repo; do not commit it.
3. `bun scripts/purge-bot-accounts.ts` (dry run) → reports 3 accounts, 3
   sessions, 3 + 2 magic links; prints domains only; writes nothing (verify the
   user count is unchanged).
4. `bun scripts/purge-bot-accounts.ts --apply` → backup path printed; the 3
   cohort users, their sessions and links, and the 2 orphan links are gone;
   every "must survive/stay" row is still there (check each with a `SELECT`).
5. Run `--apply` again → `0 accounts match — nothing to do.` (idempotent).
6. Remove the local fixture rows or run `bun run db:reset:local`.

Report the before/after counts for each fixture row.

### Step 6: Operator runbook (humans only — put this in the script header too)

```bash
# 1. Dry run against production — review counts and domains.
bun scripts/purge-bot-accounts.ts --remote

# 2. Capture a restore point (prints a bookmark; save it).
bunx wrangler d1 time-travel info trinkhallen-prod

# 3. Apply.
bun scripts/purge-bot-accounts.ts --remote --apply

# 4. If anything looks wrong, restore (this rewinds ALL writes since the bookmark).
# bunx wrangler d1 time-travel restore trinkhallen-prod --bookmark=<bookmark from step 2>
```

Expected production output at step 3: 142 accounts, 149 sessions, 150 + 489
magic links deleted; 11 users remain; `/about`'s user count is unchanged
(`countUsers` already excludes banned accounts, `src/lib/users.ts:15-25`).

## Test plan

No automated test is added. The script is a one-off and the repo convention for
one-off scripts (`scripts/backfill-usernames.ts`) has none. Verification is the
local fixture run in Step 5 (dry run, apply, idempotent re-run, every survivor
checked) plus the guards in Steps 2 and 4.

## Done criteria

- [ ] `scripts/purge-bot-accounts.ts` exists; `bun build … --target=bun` exits 0;
      `bun run lint` exits 0
- [ ] Default invocation (no flags) is a dry run against `--local`; it performs
      no write (prove with a before/after `SELECT COUNT(*) FROM users`)
- [ ] `grep -n "'@" scripts/purge-bot-accounts.ts` and
      `grep -n 'console.log(.*email' scripts/purge-bot-accounts.ts` show no
      printing of full emails
- [ ] Emails are never interpolated into SQL: every `DELETE` uses ids or a
      subquery (read the generated SQL in the dry-run output to confirm)
- [ ] Step 5 fixture run reported: 3 deleted, every survivor present, second
      `--apply` is a no-op
- [ ] `git status --short` lists only `scripts/purge-bot-accounts.ts` (plus
      `plans/README.md`)
- [ ] The executor did **not** run with `--remote --apply`
- [ ] `plans/README.md` status row for 012 updated (DONE = script merged; note
      "prod run pending operator" until the operator confirms Step 6)

## STOP conditions

Stop and report back (do not improvise) if:

- Any table with a `user_id` column exists that is not listed in the schema table
  above (`SELECT name, sql FROM sqlite_master WHERE sql LIKE '%user_id%'` on
  local D1 after migrating).
- The remote dry run (if the operator shares it) reports a cohort size other
  than 142, or any contribution count other than 0.
- A re-run after an interrupted `--apply` does not converge to 0 remaining
  cohort accounts (the statement order is supposed to make every partial state
  resumable).
- You are asked to run anything against `--remote` with `--apply`.

## Maintenance notes

- The script is single-purpose and time-boxed by its window constants. After the
  operator's production run, it can be deleted in a later cleanup commit; keep
  it until then so the run is reproducible and reviewable.
- If plan 008 has not shipped, new scanner-created accounts can keep appearing.
  They will be **outside** the July window and untouched by this script — by
  design.
- The backup JSON contains personal data. The operator should delete it once
  they are confident the purge was correct (suggest: after 30 days), consistent
  with the site's Datenschutz page.
