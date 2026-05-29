/**
 * Playwright global setup. Runs once before the webServer boots.
 *
 *  1. Writes a `.dev.vars` with a known test SESSION_SECRET so the worker (via
 *     vite-dev-server's cloudflare adapter) can sign cookies that the test
 *     helper can also sign — both sides agree on the same secret.
 *     We never overwrite an existing `.dev.vars` (the dev's real secrets stay
 *     theirs); if they want their own SECRET they're responsible for setting it
 *     to TK_TEST_SECRET below so the cookie HMAC matches.
 *
 *  2. Applies the D1 migration chain to the local DB so `users` / `sessions` /
 *     `field_signals` exist before the test seeds rows.
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

/** The test secret. Public on purpose — anything signed with it can't be a
 *  real prod session, and tests need a known fixed value. */
export const TK_TEST_SECRET = "tk-e2e-test-secret-not-for-prod-do-not-use";

export default async function globalSetup(): Promise<void> {
  if (!existsSync(".dev.vars")) {
    writeFileSync(".dev.vars", `SESSION_SECRET=${TK_TEST_SECRET}\n`);
    console.log("e2e global-setup: wrote .dev.vars with test SESSION_SECRET");
  }
  execSync("bun run db:migrate:local", { stdio: "inherit" });
}
