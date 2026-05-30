/**
 * Authed e2e flows — coverage behind the login.
 *
 * All of these ride on the test-side session-seeding pattern (see ./auth.ts):
 * a row in `users` + a row in `sessions` + a signed `__Host-tk_sess` cookie
 * that the worker accepts as the same identity. On top of that we exercise the
 * real authed surface:
 *   - /me renders the seeded identity (the seeding pattern itself)
 *   - /add is gated — anon is bounced, a session unlocks the form
 *   - the one-shot username rename write path
 *   - account deletion (session + personal-data teardown)
 *
 * Signal-flow tests (clicking confirm/dispute on a real kiosk page) are the
 * remaining gap — they just need a kiosk fixture; the auth half is solved.
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

test("/add is gated: an anonymous visitor is bounced to the login page", async ({ browser }) => {
  // No cookie seeded — the bare gate. The handler redirects to /me?after=add,
  // so a contributor who lands on /add without a session sees the login prompt
  // rather than a form that would 401 on submit.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/add");

  await expect(page).toHaveURL(/\/me\?after=add$/);
  await expect(page.locator("text=Login-Link per Mail")).toBeVisible();
  await expect(page.locator('input[name="lat"]')).toHaveCount(0);

  await context.close();
});

test("/add renders the suggest-a-kiosk form for a seeded session", async ({ browser }) => {
  const user = seedTestUser();
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    await page.goto("/add");

    // Authed: no redirect, and the location/name inputs of the suggest form
    // are present — proof the session unlocked the gate.
    await expect(page).toHaveURL(/\/add$/);
    await expect(page.locator('input[name="lat"]')).toBeVisible();
    await expect(page.locator('input[name="name"]')).toBeVisible();

    await context.close();
  } finally {
    deleteTestUser(user.userId);
  }
});

test("username rename: a fresh account can claim a new handle once", async ({ browser }) => {
  const user = seedTestUser();
  // Derive from the seeded tag so the new handle is unique per run (no clash
  // with the UNIQUE constraint on retry) and still matches [A-Za-z0-9_]{3,24}.
  const newHandle = user.username.replace(/^tester_/, "renamed_");
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    await page.goto("/me");

    await page.locator('form[action="/me/username"] input[name="username"]').fill(newHandle);
    await page.locator('form[action="/me/username"] button[type="submit"]').click();

    // The handler redirects to /me?username=ok; the new handle is shown and
    // the rename form is gone (the one-change guard fired).
    await expect(page).toHaveURL(/\/me\?username=ok$/);
    await expect(page.locator(`text=@${newHandle}`).first()).toBeVisible();
    await expect(page.locator('form[action="/me/username"]')).toHaveCount(0);

    await context.close();
  } finally {
    deleteTestUser(user.userId);
  }
});

test("account deletion tears down the session and personal data", async ({ browser }) => {
  const user = seedTestUser();
  try {
    const context = await browser.newContext();
    await setSessionCookie(context, user.cookieValue);
    const page = await context.newPage();
    await page.goto("/me");

    // The delete form lives in a collapsed <details>; expand it, confirm, submit.
    await page.locator('details:has(form[action="/me/delete"]) summary').click();
    await page.locator('form[action="/me/delete"] input[name="confirm"]').check();

    // The form carries `data-logout-form`: client JS (logout.ts) intercepts the
    // submit, POSTs via fetch (to purge the SW cache), then `location.replace`s
    // home. Wait on the actual /me/delete response so the server-side teardown
    // is committed before we re-check — otherwise we'd race the in-flight fetch.
    // We don't assert on the home landing page: `/` leans on the ASSETS binding,
    // whose vite-dev-server emulation is shaky (same reason the smoke tests
    // target /datenschutz).
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/me/delete") && r.request().method() === "POST",
      ),
      page.locator('form[action="/me/delete"] button[type="submit"]').click(),
    ]);

    // The cookie's session row is gone, so the same browser context revisiting
    // /me falls back to the unauthenticated login prompt — proof both that the
    // POST ran and that destroySession invalidated the cookie.
    await page.goto("/me");
    await expect(page.locator("text=Login-Link per Mail")).toBeVisible();
    await expect(page.locator(`text=@${user.username}`)).toHaveCount(0);

    await context.close();
  } finally {
    // Idempotent safety net — the flow already removed the rows, but a failed
    // assertion mid-test would otherwise leave them behind.
    deleteTestUser(user.userId);
  }
});
