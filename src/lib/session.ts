/**
 * Signed-cookie sessions backed by the `sessions` table in D1.
 *
 * Threat model:
 *   - Cookie value is `<sid>.<hmac>` where `hmac = HMAC-SHA256(sid, SESSION_SECRET)`.
 *   - Server stores only `sid` (random 32-byte hex) + `user_id` + `expires_at`.
 *   - Tampering breaks HMAC → cookie ignored.
 *   - Replay of a stolen cookie *is* possible until the session row is deleted.
 *     We mitigate by short TTL + rotating on privilege changes (TODO when we
 *     gain admin roles).
 *
 * Cookie attributes:
 *   - `__Host-tk_sess`: implies Secure + Path=/ + no Domain attribute.
 *   - HttpOnly, SameSite=Lax (works with the OAuth redirect roundtrip).
 *   - Max-Age 30 days, refreshed (sliding TTL) on every authenticated request.
 */

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../env";

export const SESSION_COOKIE = "__Host-tk_sess";
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

export interface SessionUser {
  id: string;
  email: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: "user" | "moderator" | "admin";
  /** True iff the row was created via magic-link and the user hasn't linked
   *  Google yet (google_sub still has the synthetic "email:<addr>" prefix).
   *  Used by /me to surface a "Connect Google" affordance. */
  isMagicLinkOnly: boolean;
}

const encoder = new TextEncoder();

export async function createSession(
  c: Context<{ Bindings: Env }>,
  userId: string,
): Promise<string> {
  const sid = randomHex(32);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const createdAt = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(sid, userId, expiresAt, createdAt)
    .run();

  const signed = await sign(sid, c.env.SESSION_SECRET);
  setCookie(c, SESSION_COOKIE, signed, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
  return sid;
}

export async function loadSession(c: Context<{ Bindings: Env }>): Promise<SessionUser | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const sid = await verify(raw, c.env.SESSION_SECRET);
  if (!sid) return null;

  const row = await c.env.DB.prepare(
    `SELECT s.id AS sid, s.expires_at AS expires_at,
              u.id AS user_id, u.email, u.username, u.display_name, u.avatar_url, u.role,
              u.google_sub
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
  )
    .bind(sid)
    .first<{
      sid: string;
      expires_at: number;
      user_id: string;
      email: string;
      username: string | null;
      display_name: string | null;
      avatar_url: string | null;
      role: "user" | "moderator" | "admin";
      google_sub: string;
    }>();

  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run();
    return null;
  }

  // Sliding TTL: refresh if the cookie is more than a day from expiring.
  if (row.expires_at - now < SESSION_TTL_SEC - 24 * 60 * 60) {
    const newExpiry = now + SESSION_TTL_SEC;
    c.executionCtx.waitUntil(
      c.env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
        .bind(newExpiry, sid)
        .run(),
    );
    const signed = await sign(sid, c.env.SESSION_SECRET);
    setCookie(c, SESSION_COOKIE, signed, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_SEC,
    });
  }

  return {
    id: row.user_id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    isMagicLinkOnly: row.google_sub.startsWith("email:"),
  };
}

export async function destroySession(c: Context<{ Bindings: Env }>): Promise<void> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (raw) {
    const sid = await verify(raw, c.env.SESSION_SECRET);
    if (sid) await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

// ── crypto helpers ──────────────────────────────────────────────────────────

async function sign(sid: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(sid));
  return `${sid}.${bufferToBase64Url(mac)}`;
}

async function verify(signed: string, secret: string): Promise<string | null> {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const sid = signed.slice(0, dot);
  const given = signed.slice(dot + 1);
  const expected = await sign(sid, secret);
  const expectedMac = expected.slice(dot + 1);
  return timingSafeEqual(given, expectedMac) ? sid : null;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

function bufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
