/**
 * Playwright global setup. Runs once after the webServer launches but before
 * the tests.
 *
 * Applies the D1 migration chain to the local DB so `users` / `sessions` /
 * `field_signals` exist before the tests seed rows. (Migrations land on the
 * persisted sqlite the worker reads live, so applying them after the worker
 * boots is fine.)
 *
 * The test SESSION_SECRET is NOT written here — the cloudflare dev adapter
 * snapshots .dev.vars at boot, which happens before this runs, so that write
 * lives in playwright.config.ts (evaluated before the webServer launches).
 */

import { execSync } from "node:child_process";

/** The test secret. Public on purpose — anything signed with it can't be a
 *  real prod session, and tests need a known fixed value. Consumed by
 *  playwright.config.ts to seed .dev.vars before the worker boots. */
export const TK_TEST_SECRET = "tk-e2e-test-secret-not-for-prod-do-not-use";

export default async function globalSetup(): Promise<void> {
  execSync("bun run db:migrate:local", { stdio: "inherit" });
}
