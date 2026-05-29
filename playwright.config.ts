import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config — runs a single Chromium smoke suite against a freshly spawned
 * `bun run dev` (Vite + @hono/vite-dev-server). The tests live in tests/e2e/
 * with a `.e2e.ts` suffix so `bun test` (which globs `*.test.ts` / `*.spec.ts`)
 * doesn't try to run them.
 *
 * Local dev: `bun run test:e2e`. The runner reuses an existing server if one
 * is already listening, so iterating with `bun run dev` open is friction-free.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  webServer: {
    // `--host 127.0.0.1` forces an IPv4 bind so Playwright's poll on the same
    // URL actually reaches Vite (default is `[::1]` only). `cloudflare:*`
    // runtime virtuals are stubbed in dev (vite.config.ts) so the worker
    // module graph resolves end-to-end.
    command: "bun run dev -- --host 127.0.0.1",
    // /datenschutz is a static SSR page that doesn't hit the ASSETS binding
    // (vite-dev-server's emulation of which is shaky); / does and would crash
    // the readiness probe. Tests target /datenschutz too.
    url: "http://127.0.0.1:5173/datenschutz",
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
