/**
 * Authed interaction flows on the kiosk pages — the contribution surface that
 * needs both a seeded session and live kiosk data. Now that /k/:id renders in
 * dev (ASSETS-fetch fix) these are reachable: check-in → signal, rating,
 * report, new-kiosk submission, and logout.
 */

import { expect, test } from "@playwright/test";
import { deleteTestUser, seedTestUser, setSessionCookie } from "./auth";
import { fetchKiosks, firstKioskWithHours } from "./kiosks";

test("a logged-in visitor gets the interactive contribution forms", async ({ browser }) => {
  const user = seedTestUser();
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    const [kiosk] = await fetchKiosks(page);
    await page.goto(`/k/${kiosk!.id}`);

    // The islands the logged-out page replaces with login prompts.
    await expect(page.locator("[data-checkin-button]")).toBeVisible();
    await expect(page.locator("[data-rating-form]")).toHaveCount(1);
    await expect(page.locator("[data-report-form]")).toHaveCount(1);

    await context.close();
  } finally {
    deleteTestUser(user.userId);
  }
});

test("rating: submitting stars + a comment updates the rating block in place", async ({
  browser,
}) => {
  const user = seedTestUser();
  const comment = `e2e rating ${user.username}`;
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    const [kiosk] = await fetchKiosks(page);
    await page.goto(`/k/${kiosk!.id}`);

    // Pick 4 stars (the radio is sr-only; its visible ★ span carries the value)
    // and write a comment, then submit. The island POSTs and swaps #rating-block.
    await page.locator('[data-rating-form] [data-star-value="4"]').click();
    await page.locator('[data-rating-form] textarea[name="comment"]').fill(comment);
    await page.locator('[data-rating-form] button[type="submit"]').first().click();

    // The swapped-in fragment shows the aggregate and the freshly written comment.
    await expect(page.locator("#rating-block")).toContainText(comment);
    await expect(page.locator("#rating-block")).toContainText("/ 5");

    await context.close();
  } finally {
    deleteTestUser(user.userId);
  }
});

test("check-in → confirm signal records and swaps in a confirmation", async ({ browser }) => {
  const user = seedTestUser();
  try {
    const context = await browser.newContext();
    await context.grantPermissions(["geolocation"]);
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    const kiosk = await firstKioskWithHours(page);
    // Stand the browser right at the kiosk so the presence fence can verify.
    await context.setGeolocation({ latitude: kiosk.lat, longitude: kiosk.lng, accuracy: 12 });

    await page.goto(`/k/${kiosk.id}`);
    await page.locator("[data-checkin-button]").click();
    // The button reveals the question block and geolocates; wait for the fix to
    // land on the wrapper before confirming (the signal POST reads it from there).
    await page.waitForFunction(
      () => !!document.querySelector("[data-checkin]")?.getAttribute("data-lat"),
      { timeout: 6000 },
    );

    const block = page.locator('[data-confirm-block][data-field-key="opening_hours"]');
    await expect(block).toBeVisible();
    await block.locator("[data-signal-confirm]").click();

    // The block is replaced by a confirmation paragraph ("Bestätigt …").
    // (Verified vs low-confidence both count — we don't gate on which.)
    await expect(page.locator('[data-confirm-block][data-field-key="opening_hours"]')).toHaveCount(
      0,
    );
    await expect(page.getByText("Bestätigt")).toBeVisible();

    await context.close();
  } finally {
    deleteTestUser(user.userId);
  }
});

test("report a correction: the form submits and redirects with a success flag", async ({
  browser,
}) => {
  const user = seedTestUser();
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    const [kiosk] = await fetchKiosks(page);
    await page.goto(`/k/${kiosk!.id}`);

    // The report form lives in a collapsed <details>; open it, pick "closed"
    // (carries its meaning in the kind alone — no extra payload required) and
    // submit. This is a plain form, so the server redirects back to the kiosk.
    await page.locator("[data-report-form] summary").click();
    await page.locator('[data-report-form] select[name="kind"]').selectOption("closed");
    await page.locator('[data-report-form] button[type="submit"]').click();

    await expect(page).toHaveURL(new RegExp(`/k/${kiosk!.id}\\?reported=ok$`));

    await context.close();
  } finally {
    deleteTestUser(user.userId);
  }
});

test("submit a new kiosk via /add lands it in the moderation queue", async ({ browser }) => {
  const user = seedTestUser();
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    await page.goto("/add");

    await page.locator('input[name="name"]').fill(`E2E Kiosk ${user.username}`);
    await page.locator('input[name="lat"]').fill("50.1109");
    await page.locator('input[name="lng"]').fill("8.6821");
    await page.locator('form[action="/add"] button[type="submit"]').click();

    // Handler stores a pending submission and redirects to the profile.
    await expect(page).toHaveURL(/\/me\?submitted=ok$/);

    await context.close();
  } finally {
    deleteTestUser(user.userId);
  }
});

test("logout ends the session", async ({ browser }) => {
  const user = seedTestUser();
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    await page.goto("/me");

    // Same data-logout-form interception as account deletion: fetch then
    // location.replace. Wait on the POST so the server-side session row is gone
    // before we re-check.
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/auth/logout") && r.request().method() === "POST",
      ),
      page.locator('section form[action="/auth/logout"] button[type="submit"]').click(),
    ]);

    await page.goto("/me");
    await expect(page.locator("text=Login-Link per Mail")).toBeVisible();

    await context.close();
  } finally {
    deleteTestUser(user.userId);
  }
});
