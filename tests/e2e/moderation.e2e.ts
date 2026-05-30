/**
 * Moderation role gate. /moderate is behind requireModerator: anonymous →
 * login redirect, plain users → 403, moderators/admins → the queue.
 */

import { expect, test } from "@playwright/test";
import { deleteTestUser, seedTestUser, setSessionCookie } from "./auth";

test("a plain user is forbidden from /moderate", async ({ browser }) => {
  const user = seedTestUser("user");
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    const res = await page.goto("/moderate");

    expect(res?.status()).toBe(403);

    await context.close();
  } finally {
    deleteTestUser(user.userId);
  }
});

test("an anonymous visitor is redirected to login from /moderate", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/moderate");

  await expect(page).toHaveURL(/\/me\?after=moderate$/);
  await context.close();
});

test("a moderator can open the moderation queue", async ({ browser }) => {
  const mod = seedTestUser("moderator");
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, mod.cookieValue);
    const page = await context.newPage();
    const res = await page.goto("/moderate");

    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Moderation" })).toBeVisible();

    await context.close();
  } finally {
    deleteTestUser(mod.userId);
  }
});
