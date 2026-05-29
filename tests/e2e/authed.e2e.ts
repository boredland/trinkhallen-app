/**
 * Authed e2e flows.
 *
 * Validates the test-side session-seeding pattern (see ./auth.ts): a row in
 * `users` + a row in `sessions` + a signed `__Host-tk_sess` cookie that the
 * worker accepts as the same identity. Once this works, signal-flow tests
 * (clicking confirm/dispute on a real kiosk page) just need a kiosk fixture
 * — the auth half is no longer the hard part.
 */

import { expect, test } from "@playwright/test";
import { deleteTestUser, seedTestUser, setSessionCookie } from "./auth";

test("a seeded session is accepted by /me — handle and email are rendered", async ({ browser }) => {
  const user = seedTestUser();
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    await page.goto("/me");

    // Authed: the handle and the user's own email appear, and the
    // unauthenticated login prompt does not.
    await expect(page.locator(`text=@${user.username}`).first()).toBeVisible();
    await expect(page.locator(`text=${user.email}`).first()).toBeVisible();
    await expect(page.locator("text=Login-Link per Mail")).toHaveCount(0);

    await context.close();
  } finally {
    deleteTestUser(user.userId);
  }
});
