/**
 * One-off backfill for the username auto-generation migration (0012).
 *
 * Assigns a unique themed handle to every user whose username is still NULL.
 * Run once after the migration is applied — local first, then production:
 *
 *   bun scripts/backfill-usernames.ts            # local D1
 *   bun scripts/backfill-usernames.ts --remote   # production D1
 *
 * Idempotent: a re-run is a no-op once every user already has a handle.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomHandleCandidate, validateUsername } from "../src/lib/usernames";

const DB = "trinkhallen-prod";
const LOCATION = process.argv.includes("--remote") ? "--remote" : "--local";

function query<T = Record<string, unknown>>(sql: string): T[] {
  const out = execFileSync(
    "bunx",
    ["wrangler", "d1", "execute", DB, LOCATION, "--json", "--command", sql],
    { encoding: "utf8" },
  );
  // wrangler prepends banner/notice lines to stdout; the --json payload is the
  // array that starts at the first bracket.
  const start = out.indexOf("[");
  const parsed = JSON.parse(start === -1 ? "[]" : out.slice(start)) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

function runFile(sql: string): void {
  const file = join(mkdtempSync(join(tmpdir(), "tk-backfill-")), "backfill.sql");
  writeFileSync(file, sql);
  execFileSync("bunx", ["wrangler", "d1", "execute", DB, LOCATION, "--file", file], {
    stdio: "inherit",
  });
}

/** Draw a handle not already live or retired (and not handed out this run). */
function freshHandle(used: Set<string>): string {
  for (let i = 0; i < 1000; i++) {
    const v = validateUsername(randomHandleCandidate());
    if (v.ok && !used.has(v.value)) {
      used.add(v.value);
      return v.value;
    }
  }
  throw new Error("could not find a free handle after 1000 attempts");
}

function main(): void {
  console.log(`Backfilling usernames (${LOCATION.slice(2)})…`);

  const used = new Set<string>();
  for (const r of query<{ u: string }>(
    "SELECT lower(username) AS u FROM users WHERE username IS NOT NULL",
  )) {
    used.add(r.u);
  }
  for (const r of query<{ u: string }>("SELECT lower(username) AS u FROM retired_usernames")) {
    used.add(r.u);
  }

  const nullUsers = query<{ id: string }>("SELECT id FROM users WHERE username IS NULL");
  console.log(`  ${nullUsers.length} user(s) without a handle.`);

  if (nullUsers.length === 0) {
    console.log("✔ Nothing to do — every user already has a handle.");
    return;
  }

  // Handles are [a-z0-9_] and ids are UUIDs, so direct interpolation is safe.
  const statements = nullUsers.map(
    (u) =>
      `UPDATE users SET username = '${freshHandle(used)}' WHERE id = '${u.id}' AND username IS NULL;`,
  );

  runFile(statements.join("\n"));
  console.log(`✔ Assigned ${nullUsers.length} handle(s).`);
}

main();
