import { existsSync, writeFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { TK_TEST_SECRET } from "./tests/e2e/global-setup";

/**
 * E2E config — runs a Chromium smoke + authed-flow suite against a freshly
 * spawned `wrangler dev`. Tests live in tests/e2e/ with a `.e2e.ts` suffix.
 *
 * Local dev: `bun run test:e2e`. The runner reuses an existing server if one
 * is already listening on the same URL.
 */

// wrangler dev reads .dev.vars when the worker boots, and Playwright launches
// `webServer` BEFORE running globalSetup — so the test SESSION_SECRET has to be
// written here, at config load. We never clobber an existing .dev.vars (a
// dev's real secrets stay theirs; if they want their own SECRET they set it to
// TK_TEST_SECRET so the cookie HMAC matches).
if (!existsSync(".dev.vars")) {
  writeFileSync(".dev.vars", `SESSION_SECRET=${TK_TEST_SECRET}\n`);
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  // One worker: tests seed/clean rows via `wrangler d1 execute --local`, and
  // concurrent wrangler processes collide on the local SQLite lock (the dev
  // server's miniflare holds it open too). Serial keeps the DB contention-free;
  // the suite is seed-bound, not CPU-bound, so we lose little.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  webServer: {
    // wrangler dev runs the full build (scripts/build-dioxus.sh) on boot —
    // incremental after a first build, hence the generous timeout. https
    // because `__Host-tk_sess` is a Secure cookie; Playwright ignores the
    // self-signed cert.
    command:
      "bunx wrangler dev --local --ip 127.0.0.1 --port 5173 --local-protocol https --var PUBLIC_ORIGIN:https://127.0.0.1:5173",
    url: "https://127.0.0.1:5173/datenschutz",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    ignoreHTTPSErrors: true,
  },
  use: {
    baseURL: "https://127.0.0.1:5173",
    // Pin the locale so the first-visit language redirect sees a German
    // Accept-Language and serves default-locale pages at their unprefixed
    // paths. Without this, Playwright's default `en-US` bounces /me → /en/me
    // and every form action picks up an /en prefix, so the authed-flow
    // selectors below would miss their targets.
    locale: "de-DE",
    headless: true,
    trace: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
