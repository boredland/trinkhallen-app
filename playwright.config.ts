import { existsSync, writeFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { TK_TEST_SECRET } from "./tests/e2e/global-setup";

/**
 * E2E config — runs a Chromium smoke + authed-flow suite against a freshly
 * spawned `bun run dev` (Vite + @hono/vite-dev-server). The tests live in
 * tests/e2e/ with a `.e2e.ts` suffix so `bun test` (which globs `*.test.ts` /
 * `*.spec.ts`) doesn't try to run them.
 *
 * Local dev: `bun run test:e2e`. The runner reuses an existing server if one
 * is already listening, so iterating with `bun run dev` open is friction-free.
 */

// The cloudflare dev adapter snapshots its env (.dev.vars) when the worker
// boots, and Playwright launches `webServer` BEFORE running globalSetup — so
// writing the test SESSION_SECRET in globalSetup is too late: the worker would
// boot with an empty secret and cookie signing throws "Zero-length key". Write
// it here, at config load, which runs before the server starts. We never clobber
// an existing .dev.vars (a dev's real secrets stay theirs; if they want their
// own SECRET they set it to TK_TEST_SECRET so the cookie HMAC matches).
if (!existsSync(".dev.vars")) {
  writeFileSync(".dev.vars", `SESSION_SECRET=${TK_TEST_SECRET}\n`);
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  webServer: {
    // `--host 127.0.0.1` forces an IPv4 bind so Playwright's poll on the same
    // URL actually reaches Vite (default is `[::1]` only). `cloudflare:*`
    // runtime virtuals are stubbed in dev (vite.config.ts) so the worker
    // module graph resolves end-to-end.
    command: "bun run dev -- --host 127.0.0.1",
    // /datenschutz is a static SSR page that doesn't hit the ASSETS binding
    // (vite-dev-server's emulation of which is shaky); / does and would crash
    // the readiness probe. Tests target /datenschutz too. https because
    // `__Host-tk_sess` is a Secure cookie (basic-ssl serves a self-signed
    // cert in dev; Playwright ignores it via `ignoreHTTPSErrors`).
    url: "https://127.0.0.1:5173/datenschutz",
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
    ignoreHTTPSErrors: true,
  },
  use: {
    baseURL: "https://127.0.0.1:5173",
    // Pin the locale so the first-visit language middleware (src/index.ts)
    // sees a German Accept-Language and serves default-locale pages at their
    // unprefixed paths. Without this, Playwright's default `en-US` bounces
    // /me → /en/me and every form action picks up an /en prefix, so the
    // authed-flow selectors below would miss their targets.
    locale: "de-DE",
    headless: true,
    trace: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
