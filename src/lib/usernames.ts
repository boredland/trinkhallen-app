/**
 * Username validation, reservation, and the set-once setter.
 *
 * Shape: `^[a-z0-9_]{3,24}$`. Lowercase only at the moment — keeps URLs and
 * @mention parsing trivial and avoids confusables (Jonas / jonas). Reserved
 * list covers top-level paths the app already serves plus a few obvious
 * impersonation surfaces; grow it as we add routes.
 *
 * Set-once is enforced at the SQL level (`WHERE username IS NULL`) so two
 * concurrent submits from the same session can't race and stamp twice.
 * Column-level edits via the D1 console stay possible for moderation —
 * that path bypasses both this module's validator and the IS NULL guard.
 */

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

const RESERVED = new Set([
  // Top-level paths the app currently serves.
  "me",
  "moderate",
  "auth",
  "api",
  "k",
  "stadt",
  "add",
  "about",
  // Roles + impersonation surfaces.
  "admin",
  "moderator",
  "support",
  "help",
  "official",
  "trinkhallen",
  "system",
  "anonymous",
  "deleted",
]);

export type SetResult = "ok" | "taken" | "invalid" | "reserved" | "already_set";

export function validateUsername(
  raw: string,
):
  | { ok: true; value: string }
  | { ok: false; reason: Exclude<SetResult, "ok" | "taken" | "already_set"> } {
  const value = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(value)) return { ok: false, reason: "invalid" };
  if (RESERVED.has(value)) return { ok: false, reason: "reserved" };
  return { ok: true, value };
}

/**
 * Set the user's username if (a) the candidate is valid, (b) it isn't already
 * taken, and (c) the user hasn't already set one. Each failure mode has its
 * own return so the route can pick a precise flash banner.
 *
 * UNIQUE violations from D1 surface as exceptions; we catch and translate to
 * `"taken"` rather than letting the route 500.
 */
export async function setUsername(
  db: D1Database,
  userId: string,
  candidate: string,
): Promise<SetResult> {
  const v = validateUsername(candidate);
  if (!v.ok) return v.reason;

  try {
    const result = await db
      .prepare(`UPDATE users SET username = ? WHERE id = ? AND username IS NULL`)
      .bind(v.value, userId)
      .run();
    if ((result.meta?.changes ?? 0) > 0) return "ok";
  } catch (err) {
    if (isUniqueViolation(err)) return "taken";
    throw err;
  }

  // The UPDATE matched zero rows. Either the user already has a username
  // (set-once enforcement) or — far less likely — their row vanished.
  // Distinguish so the flash message is precise.
  const existing = await db
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ username: string | null }>();
  return existing?.username ? "already_set" : "invalid";
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: string }).message ?? "";
  return /UNIQUE constraint failed/i.test(msg);
}
