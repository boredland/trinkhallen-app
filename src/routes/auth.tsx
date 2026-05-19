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
import type { Env } from "../env";
import { sendEmail } from "../lib/email";
import { isValidEmail, mintMagicLink, redeemMagicLink } from "../lib/magic";
import { createSession, destroySession, loadSession } from "../lib/session";

export const auth = new Hono<{ Bindings: Env }>();

/** Returns the URL Google should redirect to after consent. */
function callbackUrl(c: { env: Env }, requestUrl: string): string {
  const fromEnv = c.env.PUBLIC_ORIGIN;
  if (fromEnv && fromEnv.startsWith("http")) return `${fromEnv}/auth/google/callback`;
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
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
    });
  }
  await next();
}

async function upsertUserByEmail(db: D1Database, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first<{ id: string }>();
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
