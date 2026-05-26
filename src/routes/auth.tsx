/**
 * Google SSO via `@hono/oauth-providers/google`.
 *
 * Flow:
 *   GET /auth/google           → middleware redirects to Google's consent page
 *   GET /auth/google/callback  → middleware exchanges the code, populates
 *                                c.var.token & c.var.user-google with user info
 *   Our handler upserts the users row by google_sub, creates a session,
 *   sets the signed cookie, redirects home.
 *
 * Operator setup:
 *   1. Google Cloud Console → OAuth consent screen (External, scopes: openid,
 *      profile, email).
 *   2. Credentials → OAuth client (Web app):
 *        Authorized redirect URI: https://trinkhallen.app/auth/google/callback
 *   3. `wrangler secret put GOOGLE_CLIENT_ID`
 *      `wrangler secret put GOOGLE_CLIENT_SECRET`
 *   4. Push (auto-deploy picks it up).
 */

import { googleAuth } from "@hono/oauth-providers/google";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../env";
import {
  buildAuthorizeUrl as appleAuthorizeUrl,
  extractDisplayName as appleDisplayName,
  appleEnv,
  exchangeCode as appleExchangeCode,
  parseCallbackForm as appleParseCallback,
} from "../lib/apple-auth";
import { sendEmail } from "../lib/email";
import { isValidEmail, mintMagicLink, redeemMagicLink } from "../lib/magic";
import { createSession, destroySession, loadSession } from "../lib/session";

export const auth = new Hono<{ Bindings: Env }>();

/** Returns the URL Google should redirect to after consent. */
function callbackUrl(c: { env: Env }, requestUrl: string): string {
  const fromEnv = c.env.PUBLIC_ORIGIN;
  if (fromEnv?.startsWith("http")) return `${fromEnv}/auth/google/callback`;
  return new URL("/auth/google/callback", requestUrl).toString();
}

auth.use("/auth/google", async (c, next) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text(
      "Google SSO is not yet configured on this deployment. The operator needs to set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets.",
      503,
    );
  }
  const handler = googleAuth({
    client_id: c.env.GOOGLE_CLIENT_ID,
    client_secret: c.env.GOOGLE_CLIENT_SECRET,
    scope: ["openid", "email", "profile"],
    redirect_uri: callbackUrl(c, c.req.url),
  });
  return handler(c, next);
});

auth.use("/auth/google/callback", async (c, next) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text("Google SSO is not configured.", 503);
  }
  const handler = googleAuth({
    client_id: c.env.GOOGLE_CLIENT_ID,
    client_secret: c.env.GOOGLE_CLIENT_SECRET,
    scope: ["openid", "email", "profile"],
    redirect_uri: callbackUrl(c, c.req.url),
  });
  return handler(c, next);
});

auth.get("/auth/google/callback", async (c) => {
  const profile = c.get("user-google");
  if (!profile?.id || !profile.email) {
    return c.text("Google login did not return a usable profile.", 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const currentUser = c.get("user");

  // Already logged in and starting Google OAuth from /me → link mode. We
  // trust the current session's identity (verified once via magic-link)
  // and Google's identity (verified just now via OAuth), so attach the
  // Google sub to the existing row regardless of whether the email
  // addresses agree. The two halves of the merge are each independently
  // verified, which is the security invariant that matters.
  if (currentUser) {
    const outcome = await linkGoogleToCurrentUser(c.env.DB, {
      userId: currentUser.id,
      googleSub: profile.id,
      googleEmail: profile.email,
      displayName: profile.name ?? profile.given_name ?? null,
      avatarUrl: profile.picture ?? null,
    });
    if (outcome === "conflict") {
      // Google sub is already attached to some *other* row. Refuse to
      // re-point it — the user would need to sign in as that other
      // account first if they want to consolidate.
      return c.redirect("/me?link=conflict");
    }
    return c.redirect("/me?link=ok");
  }

  // Plain Google sign-in (no existing session).
  const userId = await upsertUser(c.env.DB, {
    googleSub: profile.id,
    email: profile.email,
    displayName: profile.name ?? profile.given_name ?? null,
    avatarUrl: profile.picture ?? null,
    now,
  });

  await createSession(c, userId);
  return c.redirect("/me");
});

// ── Sign in with Apple ──────────────────────────────────────────────────────
//
// Required by App Store Review Guideline 4.8 because our iOS wrapper exposes
// Google SSO. The flow is form_post-based (Apple POSTs across origins), so
// state lives in a SameSite=None cookie set on the redirect side. See
// src/lib/apple-auth.ts for the JWT-signed client_secret + id_token exchange.

const APPLE_STATE_COOKIE = "__tk_apple_state";

function appleCallbackUrl(c: { env: Env }, requestUrl: string): string {
  const fromEnv = c.env.PUBLIC_ORIGIN;
  if (fromEnv?.startsWith("http")) return `${fromEnv}/auth/apple/callback`;
  return new URL("/auth/apple/callback", requestUrl).toString();
}

auth.get("/auth/apple", async (c) => {
  const apple = appleEnv(c.env);
  if (!apple) {
    return c.text(
      "Apple SSO is not yet configured on this deployment. The operator needs to set APPLE_SIGN_IN_{SERVICES_ID,TEAM_ID,KEY_ID,PRIVATE_KEY}.",
      503,
    );
  }
  const state = crypto.randomUUID();
  // SameSite=None so the cookie survives Apple's cross-site POST back to
  // /auth/apple/callback. HttpOnly + Secure to keep the value out of JS
  // and off plaintext networks.
  setCookie(c, APPLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/auth/apple",
    maxAge: 600,
  });
  return c.redirect(appleAuthorizeUrl(apple, appleCallbackUrl(c, c.req.url), state));
});

auth.post("/auth/apple/callback", async (c) => {
  const apple = appleEnv(c.env);
  if (!apple) return c.text("Apple SSO is not configured.", 503);

  const form = appleParseCallback(await c.req.formData());
  if (form.error) return c.text(`Apple sign-in error: ${form.error}`, 400);
  if (!form.code) return c.text("Apple sign-in did not return an authorization code.", 400);

  // CSRF: the state in Apple's POST body must match the one we set in
  // the cookie when redirecting. One-shot — clear it either way.
  const expected = getCookie(c, APPLE_STATE_COOKIE);
  deleteCookie(c, APPLE_STATE_COOKIE, { path: "/auth/apple" });
  if (!expected || form.state !== expected) {
    return c.text("Apple sign-in state mismatch (possible CSRF).", 400);
  }

  let idToken: Awaited<ReturnType<typeof appleExchangeCode>>;
  try {
    idToken = await appleExchangeCode(apple, form.code, appleCallbackUrl(c, c.req.url));
  } catch (err) {
    console.error("apple token exchange failed", err);
    return c.text("Apple sign-in could not exchange the code.", 502);
  }

  if (!idToken.sub) return c.text("Apple sign-in returned no user identifier.", 400);
  // No email means the user denied the email scope. We can't create an
  // account without one (magic-link + future contact rely on it).
  if (!idToken.email) {
    return c.text(
      "Apple sign-in returned no email. Re-enable 'Share My Email' on the next try.",
      400,
    );
  }

  const displayName = appleDisplayName(form.user);
  const now = Math.floor(Date.now() / 1000);
  const currentUser = c.get("user");

  if (currentUser) {
    const outcome = await linkAppleToCurrentUser(c.env.DB, {
      userId: currentUser.id,
      appleSub: idToken.sub,
      appleEmail: idToken.email,
      displayName,
    });
    if (outcome === "conflict") return c.redirect("/me?link=conflict");
    return c.redirect("/me?link=ok");
  }

  const userId = await upsertUserByApple(c.env.DB, {
    appleSub: idToken.sub,
    email: idToken.email,
    displayName,
    now,
  });
  await createSession(c, userId);
  return c.redirect("/me");
});

auth.post("/auth/logout", async (c) => {
  await destroySession(c);
  return c.redirect("/");
});

// Convenience GET for the "log out" link in the header (no JS needed).
auth.get("/auth/logout", async (c) => {
  await destroySession(c);
  return c.redirect("/");
});

// ── Magic-link auth ─────────────────────────────────────────────────────────

auth.post("/auth/magic", async (c) => {
  const form = await c.req.formData();
  const email = (form.get("email") ?? "").toString().trim().toLowerCase();

  // Always render the same "check your email" success so existence isn't
  // leaked. The bad-email case is the only signal we surface.
  if (!isValidEmail(email)) {
    return c.redirect("/me?magic=invalid");
  }

  const link = await mintMagicLink(c.env, email, {
    userAgent: c.req.header("user-agent") ?? null,
    ip: c.req.header("cf-connecting-ip") ?? null,
  });

  if (link) {
    const origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
    const verifyUrl = `${origin}/auth/magic/verify?token=${encodeURIComponent(`${link.id}.${link.token}`)}`;
    try {
      await sendEmail(c.env, {
        to: email,
        subject: "Dein trinkhallen.app Login",
        text: [
          "Hallo,",
          "",
          "klicke auf den folgenden Link, um dich bei trinkhallen.app einzuloggen:",
          verifyUrl,
          "",
          "Der Link ist 15 Minuten gültig und kann nur einmal verwendet werden.",
          "",
          "Wenn du das nicht angefragt hast, kannst du diese Mail ignorieren.",
          "",
          "— trinkhallen.app",
        ].join("\r\n"),
        html:
          `<p>Hallo,</p>` +
          `<p>klicke auf den folgenden Link, um dich bei <strong>trinkhallen.app</strong> einzuloggen:</p>` +
          `<p><a href="${verifyUrl}" style="display:inline-block;padding:.6rem 1rem;background:#FF2D6F;color:#0A0A0A;font-family:Anton,sans-serif;letter-spacing:.05em;text-decoration:none">▶ Einloggen</a></p>` +
          `<p style="color:#666;font-size:0.9em">Der Link ist 15 Minuten gültig und kann nur einmal verwendet werden. Wenn du das nicht angefragt hast, kannst du diese Mail ignorieren.</p>` +
          `<p style="color:#999;font-size:0.85em">— trinkhallen.app</p>`,
      });
    } catch (err) {
      console.error("magic email send failed", err);
      // Still report success to the user — abuse signal otherwise.
    }
  }

  return c.redirect("/me?magic=sent");
});

auth.get("/auth/magic/verify", async (c) => {
  const token = c.req.query("token");
  if (!token) return c.redirect("/me?magic=invalid");

  const result = await redeemMagicLink(c.env, token);
  if (!result) return c.redirect("/me?magic=expired");

  const userId = await upsertUserByEmail(c.env.DB, result.email);
  await createSession(c, userId);
  return c.redirect("/me");
});

/**
 * Middleware that hydrates `c.var.user` for downstream handlers and Layouts.
 * Always attached at app root; missing/invalid session is silently `undefined`.
 */
export async function attachUser(
  c: import("hono").Context<{ Bindings: Env }>,
  next: () => Promise<void>,
): Promise<void> {
  const user = await loadSession(c);
  if (user) {
    c.set("user", {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
      isMagicLinkOnly: user.isMagicLinkOnly,
      hasGoogle: user.hasGoogle,
      hasApple: user.hasApple,
    });
  }
  await next();
}

/**
 * Attach a Google identity to the currently-logged-in user. Used by the
 * /me "Google verbinden" flow, where the security model is:
 *   - The user proved they own this row in the past (magic-link email or
 *     prior Google login), and the session cookie carries that.
 *   - Google just freshly verified that the same browser controls a
 *     Google account with sub=profile.id.
 * Linking them is safe regardless of email match, so don't gate on it.
 *
 * Returns "ok" on success, "conflict" if the Google sub is already
 * attached to a different account (which would need a separate
 * consolidation flow to resolve safely).
 */
async function linkGoogleToCurrentUser(
  db: D1Database,
  args: {
    userId: string;
    googleSub: string;
    googleEmail: string;
    displayName: string | null;
    avatarUrl: string | null;
  },
): Promise<"ok" | "conflict"> {
  // Reject if Google sub already lives on a different row.
  const other = await db
    .prepare(`SELECT id FROM users WHERE google_sub = ? AND id != ?`)
    .bind(args.googleSub, args.userId)
    .first<{ id: string }>();
  if (other) return "conflict";

  // COALESCE keeps display_name/avatar_url the user already had (they
  // may have come from a previous Google login, or be hand-set later).
  await db
    .prepare(
      `UPDATE users
          SET google_sub = ?,
              display_name = COALESCE(display_name, ?),
              avatar_url = COALESCE(avatar_url, ?)
        WHERE id = ?`,
    )
    .bind(args.googleSub, args.displayName, args.avatarUrl, args.userId)
    .run();
  return "ok";
}

async function upsertUserByEmail(db: D1Database, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .bind(email)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  // For magic-link signups we use the email as a synthetic google_sub so the
  // unique constraint holds; if the user later links Google, we overwrite it.
  const syntheticSub = `email:${email}`;
  await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, display_name, avatar_url, role, created_at)
       VALUES (?, ?, ?, NULL, NULL, 'user', ?)`,
    )
    .bind(id, syntheticSub, email, now)
    .run();
  return id;
}

async function upsertUser(
  db: D1Database,
  args: {
    googleSub: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    now: number;
  },
): Promise<string> {
  // 1. Already-linked account — direct google_sub hit.
  const existing = await db
    .prepare(`SELECT id FROM users WHERE google_sub = ?`)
    .bind(args.googleSub)
    .first<{ id: string }>();
  if (existing) {
    // Refresh denormalised profile fields opportunistically.
    await db
      .prepare(`UPDATE users SET email = ?, display_name = ?, avatar_url = ? WHERE id = ?`)
      .bind(args.email, args.displayName, args.avatarUrl, existing.id)
      .run();
    return existing.id;
  }

  // 2. Magic-link signup being linked to Google. Both Google and our own
  //    magic-link have verified this email, so transparently upgrading the
  //    row is safe. Guard on `email:` prefix so a real Google sub belonging
  //    to a different person sharing the email never gets clobbered.
  //    COALESCE keeps any display_name/avatar_url the user set themselves
  //    over the Google profile fields.
  const byEmail = await db
    .prepare(`SELECT id, google_sub FROM users WHERE email = ?`)
    .bind(args.email)
    .first<{ id: string; google_sub: string }>();
  if (byEmail?.google_sub.startsWith("email:")) {
    await db
      .prepare(
        `UPDATE users
            SET google_sub = ?,
                display_name = COALESCE(display_name, ?),
                avatar_url = COALESCE(avatar_url, ?)
          WHERE id = ?`,
      )
      .bind(args.googleSub, args.displayName, args.avatarUrl, byEmail.id)
      .run();
    return byEmail.id;
  }

  // 3. Brand-new user.
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, display_name, avatar_url, role, created_at)
       VALUES (?, ?, ?, ?, ?, 'user', ?)`,
    )
    .bind(id, args.googleSub, args.email, args.displayName, args.avatarUrl, args.now)
    .run();
  return id;
}

/**
 * Attach an Apple identity to a logged-in user. Mirrors linkGoogleToCurrentUser
 * — the session already proves they own this row, Apple just freshly proved
 * sub ownership, link is safe regardless of email match. Conflict only when
 * apple_sub is already attached to a different account.
 */
async function linkAppleToCurrentUser(
  db: D1Database,
  args: { userId: string; appleSub: string; appleEmail: string; displayName: string | null },
): Promise<"ok" | "conflict"> {
  const other = await db
    .prepare(`SELECT id FROM users WHERE apple_sub = ? AND id != ?`)
    .bind(args.appleSub, args.userId)
    .first<{ id: string }>();
  if (other) return "conflict";
  await db
    .prepare(
      `UPDATE users
          SET apple_sub = ?,
              display_name = COALESCE(display_name, ?)
        WHERE id = ?`,
    )
    .bind(args.appleSub, args.displayName, args.userId)
    .run();
  return "ok";
}

/**
 * Upsert via Apple. Three branches mirror upsertUser (google):
 *   1. Already-linked apple_sub → reuse, refresh email/display_name
 *   2. Magic-link signup with matching email (synthetic `email:` google_sub)
 *      → attach apple_sub in place, keep the magic-link history
 *   3. Brand-new user → insert with no google_sub yet (will get one if they
 *      later sign in with Google too)
 *
 * Note that unlike Google, Apple users come in WITHOUT a google_sub initially.
 * The users.google_sub column is NOT NULL UNIQUE, so we have to synthesise
 * a placeholder for brand-new Apple users using the `apple:<sub>` prefix —
 * the same trick the magic-link path uses with `email:<addr>`.
 */
async function upsertUserByApple(
  db: D1Database,
  args: {
    appleSub: string;
    email: string;
    displayName: string | null;
    now: number;
  },
): Promise<string> {
  const existing = await db
    .prepare(`SELECT id FROM users WHERE apple_sub = ?`)
    .bind(args.appleSub)
    .first<{ id: string }>();
  if (existing) {
    await db
      .prepare(`UPDATE users SET email = ?, display_name = COALESCE(display_name, ?) WHERE id = ?`)
      .bind(args.email, args.displayName, existing.id)
      .run();
    return existing.id;
  }

  const byEmail = await db
    .prepare(`SELECT id, google_sub FROM users WHERE email = ?`)
    .bind(args.email)
    .first<{ id: string; google_sub: string }>();
  if (byEmail?.google_sub.startsWith("email:")) {
    await db
      .prepare(
        `UPDATE users
            SET apple_sub = ?,
                display_name = COALESCE(display_name, ?)
          WHERE id = ?`,
      )
      .bind(args.appleSub, args.displayName, byEmail.id)
      .run();
    return byEmail.id;
  }

  const id = crypto.randomUUID();
  const syntheticGoogleSub = `apple:${args.appleSub}`;
  await db
    .prepare(
      `INSERT INTO users (id, google_sub, apple_sub, email, display_name, avatar_url, role, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'user', ?)`,
    )
    .bind(id, syntheticGoogleSub, args.appleSub, args.email, args.displayName, args.now)
    .run();
  return id;
}
