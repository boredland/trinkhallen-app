/**
 * Magic-link signup / login.
 *
 * Token is a random opaque secret. The DB stores its SHA-256 — a DB leak can't
 * be used to log in. The URL contains `<id>.<token>` so we can lookup by id
 * fast and verify by comparing token hashes.
 *
 * TTL: 15 minutes. Single use (consumed_at marks redemption).
 *
 * Rate limit: at most 5 unconsumed tokens per email at any time; further
 * requests are silently no-op'd to avoid signalling email-existence.
 */

import type { Env } from "../env";

export const MAGIC_TTL_SEC = 15 * 60;
const MAX_OUTSTANDING_PER_EMAIL = 5;

export interface MintedLink {
  id: string;
  token: string;
}

export async function mintMagicLink(
  env: Env,
  email: string,
  meta: { userAgent?: string | null; ip?: string | null },
): Promise<MintedLink | null> {
  const now = Math.floor(Date.now() / 1000);

  // Cheap rate-limit: pending unconsumed tokens for this email.
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM magic_links
       WHERE email = ? AND consumed_at IS NULL AND expires_at > ?`,
  )
    .bind(email, now)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_OUTSTANDING_PER_EMAIL) return null;

  const id = randomHex(16);
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + MAGIC_TTL_SEC;

  await env.DB.prepare(
    `INSERT INTO magic_links (id, token_hash, email, expires_at, created_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, tokenHash, email, expiresAt, now, meta.userAgent ?? null, meta.ip ?? null)
    .run();

  return { id, token };
}

export interface RedeemedLink {
  email: string;
}

export async function redeemMagicLink(env: Env, rawToken: string): Promise<RedeemedLink | null> {
  const dot = rawToken.indexOf(".");
  if (dot <= 0) return null;
  const id = rawToken.slice(0, dot);
  const token = rawToken.slice(dot + 1);
  if (!id || !token) return null;

  const row = await env.DB.prepare(
    `SELECT email, token_hash, expires_at, consumed_at FROM magic_links WHERE id = ?`,
  )
    .bind(id)
    .first<{ email: string; token_hash: string; expires_at: number; consumed_at: number | null }>();
  if (!row) return null;
  if (row.consumed_at) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) return null;

  const candidate = await sha256Hex(token);
  if (!timingSafeEqual(candidate, row.token_hash)) return null;

  await env.DB.prepare(`UPDATE magic_links SET consumed_at = ? WHERE id = ?`).bind(now, id).run();
  return { email: row.email };
}

export function isValidEmail(s: string): boolean {
  // Permissive but bounded RFC-ish check; real validation happens at delivery.
  return /^[^\s@<>"]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(s) && s.length <= 254;
}

// ── crypto helpers ──────────────────────────────────────────────────────────

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
