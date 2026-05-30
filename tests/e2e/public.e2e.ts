/**
 * Public surface — the no-auth pages, exercised in a real browser against live
 * kiosk data (the fixture in CI, the full dataset locally). These cover the
 * data path that 500'd in dev before the ASSETS-fetch fix, plus the
 * locale-routing the unit tests check at the middleware level.
 */

import { expect, test } from "@playwright/test";
import { fetchKiosks } from "./kiosks";

test("the map page renders the kiosk list from live data", async ({ page }) => {
  await page.goto("/");
  // The side panel is server-rendered with real rows — this is exactly what
  // broke when env.ASSETS.fetch got a cross-realm Request and the page 500'd.
  const kioskLinks = page.locator('#kiosk-panel a[href*="/k/"]');
  expect(await kioskLinks.count()).toBeGreaterThan(0);
});

test("a kiosk detail page renders its name and contribution sections", async ({ page }) => {
  const [kiosk] = await fetchKiosks(page);
  expect(kiosk, "no kiosks from /api/kiosks").toBeTruthy();

  await page.goto(`/k/${kiosk!.id}`);
  await expect(page.locator("h1")).toContainText(kiosk!.name);
  // The three contribution blocks render their headings even when logged out…
  await expect(page.getByRole("heading", { name: "Bewertungen" })).toBeVisible();
  // …but the interactive check-in island only mounts for an authed user; a
  // logged-out visitor gets a login prompt instead.
  await expect(page.locator("[data-checkin-button]")).toHaveCount(0);
  await expect(page.locator('a[href="/me"]').first()).toBeVisible();
});

test("/jetzt (open-now) renders", async ({ page }) => {
  const res = await page.goto("/jetzt");
  expect(res?.status()).toBe(200);
  await expect(page.locator("h1")).toBeVisible();
});

test("/stadt/frankfurt lists the city's kiosks", async ({ page }) => {
  const res = await page.goto("/stadt/frankfurt");
  expect(res?.status()).toBe(200);
  await expect(page.locator("h1")).toContainText("Frankfurt");
  expect(await page.locator('a[href*="/k/"]').count()).toBeGreaterThan(0);
});

test("legal pages render their headings", async ({ page }) => {
  await page.goto("/impressum");
  await expect(page.locator("h1, h2").first()).toBeVisible();
  await page.goto("/datenschutz");
  await expect(page.locator("h1, h2").first()).toBeVisible();
});

test("an unknown kiosk id returns a 404 page", async ({ page }) => {
  const res = await page.goto("/k/tk_fr_doesnotexist");
  expect(res?.status()).toBe(404);
  // The not-found page echoes the missing id rather than a blank error.
  await expect(page.locator("body")).toContainText("tk_fr_doesnotexist");
});

test("an unknown path returns the catch-all 404", async ({ page }) => {
  const res = await page.goto("/this-route-does-not-exist");
  expect(res?.status()).toBe(404);
});

test("?setlang=en switches the locale and persists a cookie", async ({ browser }) => {
  const context = await browser.newContext({ locale: "de-DE" });
  const page = await context.newPage();
  await page.goto("/impressum?setlang=en");

  await expect(page).toHaveURL(/\/en\/impressum$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const langCookie = (await context.cookies()).find((c) => c.name === "tk_lang");
  expect(langCookie?.value).toBe("en");
  await context.close();
});

test("an English-preferring first visit is redirected to /en", async ({ browser }) => {
  // A fresh context with an English Accept-Language exercises the first-visit
  // language middleware end-to-end (the unit tests cover it at the app level).
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await page.goto("/impressum");
  await expect(page).toHaveURL(/\/en\/impressum$/);
  await context.close();
});
