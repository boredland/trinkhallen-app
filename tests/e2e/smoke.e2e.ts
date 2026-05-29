/**
 * Real-browser smoke test.
 *
 * Catches the bug class that happy-dom can't: the deployed JS bundle never
 * loaded, OR the service worker served an ancient cached bundle that's
 * missing the current code. We hit a public page in a fresh Chromium and
 * confirm the install side-effect (`__tkCheckinInstalled`) actually fires —
 * which it only does if the bundle loaded, parsed, ran, and reached the end
 * of `installCheckinForm()`.
 *
 * The home page is intentional: it requires no auth and still loads
 * app.entry.ts (which calls installCheckinForm). Adding kiosk-detail /
 * authed flows is a follow-up once we have a session-seeding helper.
 */

import { expect, test } from "@playwright/test";

test("page loads, JS bundle runs, check-in client installs (no console errors)", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  // /datenschutz is a static SSR page (no kiosk-asset lookups) that still
  // loads `app.entry.ts`, so it's the cheapest target for booting the bundle.
  await page.goto("/datenschutz");
  // Wait for the install marker rather than a fixed timeout — the bundle is
  // module-loaded so installCheckinForm fires shortly after DOMContentLoaded.
  await page.waitForFunction(
    () => (window as { __tkCheckinInstalled?: boolean }).__tkCheckinInstalled === true,
    { timeout: 10_000 },
  );

  // No "Uncaught" errors during the boot. The smoke is that the page is
  // reachable, the JS bundle parsed and ran, and nothing else screamed.
  expect(errors, `unexpected JS errors:\n${errors.join("\n")}`).toEqual([]);
});

test("the click listener really attached: synthetic dispatch hits the network", async ({
  page,
}) => {
  // /datenschutz is a static SSR page (no kiosk-asset lookups) that still
  // loads `app.entry.ts`, so it's the cheapest target for booting the bundle.
  await page.goto("/datenschutz");
  await page.waitForFunction(
    () => (window as { __tkCheckinInstalled?: boolean }).__tkCheckinInstalled === true,
    { timeout: 10_000 },
  );

  // Stub fetch so we can detect that the document-level click delegation
  // wired up correctly, without needing an authed session or a real signal
  // round-trip. If the bundle is the stale one without the dispatcher, the
  // synthetic click click goes nowhere and the test fails on the assertion.
  const hit = await page.evaluate(async () => {
    let called = false;
    const realFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : ((input as Request).url ?? String(input));
      if (url.includes("/api/signals")) {
        called = true;
        return new Response(JSON.stringify({ verified: true, reason: null }), { status: 200 });
      }
      return realFetch(input as Parameters<typeof fetch>[0], init);
    };
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div data-checkin data-kiosk-id="tk_smoke_001" data-lat="50.1" data-lng="8.7" data-accuracy="10">
         <div data-confirm-block>
           <button type="button" data-signal-confirm data-field-key="opening_hours">go</button>
         </div>
       </div>`,
    );
    document.querySelector<HTMLButtonElement>("[data-signal-confirm]")!.click();
    // Yield until the handler's awaited fetch + json + DOM swap can settle.
    for (let i = 0; i < 10 && !called; i++) await new Promise((r) => setTimeout(r, 50));
    return called;
  });

  expect(hit).toBe(true);
});
