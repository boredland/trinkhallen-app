/**
 * Username generation, validation, and the change-once rename.
 *
 * Handles are auto-assigned at signup (generateUniqueUsername) from a themed
 * noun×persona vocab, e.g. `pfand_pirat_4821`. Shape: `^[a-z0-9_]{3,24}$`,
 * lowercase only — keeps URLs and @mention parsing trivial and avoids confusables
 * (Jonas / jonas). The reserved list covers top-level paths the app serves plus a
 * few obvious impersonation surfaces; grow it as we add routes.
 *
 * Users may rename exactly once (renameUsername): the auto-assigned name does
 * not count, enforcement is race-safe via `WHERE username_changed_at IS NULL`,
 * and the freed handle is retired (never recycled) so nobody can assume a
 * prior public identity.
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

export function validateUsername(
  raw: string,
): { ok: true; value: string } | { ok: false; reason: "invalid" | "reserved" } {
  const value = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(value)) return { ok: false, reason: "invalid" };
  if (RESERVED.has(value)) return { ok: false, reason: "reserved" };
  return { ok: true, value };
}

// ── Themed generation ────────────────────────────────────────────────────────
//
// `<spaeti-wort>_<persona>_<10..9999>`, e.g. `pfand_pirat_4821`. Deliberately
// two NOUNS, not adjective+noun: German adjectives would have to decline for the
// noun's gender/case (durstig*es* Wegbier vs durstig*er* Spaeti), and a free
// cross-product also yields nonsense ("thirsty to-go-beer"). With a Späti noun
// colouring a persona, every pairing instead reads as a sensible nickname
// ("der Pfand-Pirat", "die Mate-Fee"). Words are ascii-lowercase and ≤ 9 chars
// so the longest handle stays within the 24-char cap; ~32×32×9990 ≈ 10M
// combinations keep collisions rare, and the random suffix keeps handles from
// leaking signup order or user count.

const PREFIXES = [
  "pfand",
  "wegbier",
  "mate",
  "limo",
  "kiosk",
  "korn",
  "pils",
  "astra",
  "aeppler",
  "spaeti",
  "brause",
  "hopfen",
  "malz",
  "nacht",
  "feier",
  "durst",
  "pegel",
  "tresen",
  "theke",
  "deckel",
  "senf",
  "pommes",
  "bier",
  "schnaps",
  "kippe",
  "bonbon",
  "flasche",
  "stulle",
  "koffein",
  "zucker",
  "sprudel",
  "spezi",
  "wodka",
  "kassen",
] as const;

const PERSONAS = [
  "pirat",
  "held",
  "wicht",
  "koenig",
  "fee",
  "streuner",
  "kumpel",
  "nerd",
  "fuchs",
  "kobold",
  "geist",
  "baron",
  "ritter",
  "lord",
  "hai",
  "ninja",
  "freund",
  "meister",
  "fan",
  "kenner",
  "profi",
  "veteran",
  "kaiser",
  "zwerg",
  "schreck",
  "bandit",
  "magier",
  "riese",
  "kumpan",
  "schelm",
  "gnom",
  "pilot",
] as const;

function randomInt(maxExclusive: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % maxExclusive;
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(arr.length)]!;
}

/** A candidate handle like `pfand_pirat_4821`. Not checked for uniqueness. */
export function randomHandleCandidate(): string {
  return `${pick(PREFIXES)}_${pick(PERSONAS)}_${10 + randomInt(9990)}`;
}

async function isHandleFree(db: D1Database, value: string): Promise<boolean> {
  const hit = await db
    .prepare(
      `SELECT 1 FROM users WHERE lower(username) = ?1
       UNION ALL
       SELECT 1 FROM retired_usernames WHERE lower(username) = ?1
       LIMIT 1`,
    )
    .bind(value)
    .first();
  return !hit;
}

/** Auto-assign a unique, valid, themed handle. Used at signup. */
export async function generateUniqueUsername(db: D1Database): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const v = validateUsername(randomHandleCandidate());
    if (v.ok && (await isHandleFree(db, v.value))) return v.value;
  }
  // Pathological-collision fallback: keep drawing until something free turns
  // up. Still themed, just with a wider suffix.
  for (;;) {
    const v = validateUsername(`${pick(PERSONAS)}_${randomInt(1_000_000)}`);
    if (v.ok && (await isHandleFree(db, v.value))) return v.value;
  }
}

// ── Change-once rename ───────────────────────────────────────────────────────

export type RenameResult =
  | "ok"
  | "taken"
  | "invalid"
  | "reserved"
  | "retired"
  | "unchanged"
  | "already_changed";

/**
 * Rename the user's handle if (a) the candidate is valid, (b) it isn't taken or
 * retired, and (c) the user hasn't already used their one change. Each failure
 * mode has its own return so the route can pick a precise flash banner.
 *
 * The one-change guard lives in SQL (`WHERE username_changed_at IS NULL`) so two
 * concurrent submits can't both stamp. UNIQUE violations surface as exceptions;
 * we translate to "taken" rather than 500ing. The freed handle is retired
 * afterwards so it can never be reclaimed.
 */
export async function renameUsername(
  db: D1Database,
  userId: string,
  candidate: string,
): Promise<RenameResult> {
  const v = validateUsername(candidate);
  if (!v.ok) return v.reason;

  const cur = await db
    .prepare(`SELECT username, username_changed_at AS changedAt FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ username: string | null; changedAt: number | null }>();
  if (!cur) return "invalid";
  if (cur.changedAt != null) return "already_changed";
  if (cur.username && cur.username.toLowerCase() === v.value) return "unchanged";

  const retired = await db
    .prepare(`SELECT 1 FROM retired_usernames WHERE lower(username) = ?`)
    .bind(v.value)
    .first();
  if (retired) return "retired";

  const now = Math.floor(Date.now() / 1000);
  try {
    const res = await db
      .prepare(
        `UPDATE users SET username = ?, username_changed_at = ?
          WHERE id = ? AND username_changed_at IS NULL`,
      )
      .bind(v.value, now, userId)
      .run();
    if ((res.meta?.changes ?? 0) === 0) return "already_changed";
  } catch (err) {
    if (isUniqueViolation(err)) return "taken";
    throw err;
  }

  if (cur.username) {
    await db
      .prepare(`INSERT OR IGNORE INTO retired_usernames (username, retired_at) VALUES (?, ?)`)
      .bind(cur.username.toLowerCase(), now)
      .run();
  }
  return "ok";
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = (err as { message?: string }).message ?? "";
  return /UNIQUE constraint failed/i.test(msg);
}
