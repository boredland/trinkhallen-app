/**
 * Real-browser smoke test.
 *
 * Catches the bug class unit tests can't: the deployed client bundle never
 * loaded (CSP, wrong asset URL, a stale service-worker copy), or it panicked
 * on boot. The client sets `__tkClientReady` only after `start()` ran to the
 * end — island hydration and every page behaviour installed.
 */

import { expect, test } from "@playwright/test";

test("page loads, client bundle boots, no console errors", async ({ page }) => {
  const errors: string[] = [];
  // The self-signed dev cert trips the SW's own script fetch with an SSL
  // warning we can't `ignoreHTTPSErrors` past — expected dev-only noise.
  const IGNORED = /SSL certificate error|service.worker/i;
  page.on("pageerror", (e) => {
    if (!IGNORED.test(e.message)) errors.push(`pageerror: ${e.message}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORED.test(m.text())) {
      errors.push(`console.error: ${m.text()}`);
    }
  });

  // /datenschutz is a static page (no kiosk-data lookups) that still loads
  // the client, so it's the cheapest target for booting the bundle.
  await page.goto("/datenschutz");
  await page.waitForFunction(
    () => (window as { __tkClientReady?: boolean }).__tkClientReady === true,
    { timeout: 10_000 },
  );

  expect(errors, `unexpected JS errors:\n${errors.join("\n")}`).toEqual([]);
});
