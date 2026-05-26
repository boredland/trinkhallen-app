/**
 * Ratings (1–5 stars, optional comment, one per user per kiosk).
 *
 * Aggregates are computed on the fly in SQL — for a kiosk with O(10²)
 * ratings this is trivial, and no denormalised counter to keep in sync.
 */

import type { Env } from "../env";

export interface RatingRow {
  kiosk_id: string;
  user_id: string;
  stars: number;
  comment: string | null;
  created_at: number;
  updated_at: number;
}

export interface Aggregate {
  avg: number; // 0 if count == 0
  count: number;
  histogram: [number, number, number, number, number]; // index 0 = 1-star count
}

export async function getOwnRating(
  env: Env,
  kioskId: string,
  userId: string,
): Promise<RatingRow | null> {
  return env.DB.prepare(`SELECT * FROM ratings WHERE kiosk_id = ? AND user_id = ?`)
    .bind(kioskId, userId)
    .first<RatingRow>();
}

export async function getAggregate(env: Env, kioskId: string): Promise<Aggregate> {
  // Shadow-banned authors are excluded from the public aggregate. The banned
  // user themselves still sees their own row via getOwnRating, which is the
  // "shadow" part — they don't notice they've been muted.
  const { results } = await env.DB.prepare(
    `SELECT r.stars, COUNT(*) AS n
       FROM ratings r JOIN users u ON u.id = r.user_id
       WHERE r.kiosk_id = ? AND u.banned_at IS NULL
       GROUP BY r.stars`,
  )
    .bind(kioskId)
    .all<{ stars: number; n: number }>();
  const hist: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let total = 0;
  let weighted = 0;
  for (const r of results) {
    const idx = r.stars - 1;
    if (idx >= 0 && idx < 5) {
      hist[idx] = r.n;
      total += r.n;
      weighted += r.n * r.stars;
    }
  }
  return {
    avg: total === 0 ? 0 : weighted / total,
    count: total,
    histogram: hist,
  };
}

export interface RatingComment {
  author: string;
  stars: number;
  comment: string;
  updatedAt: number;
}

/** Ratings that carry a written comment, newest first. Banned authors are
 *  excluded (same shadow-ban policy as the aggregate). */
export async function listComments(
  env: Env,
  kioskId: string,
  limit = 50,
): Promise<RatingComment[]> {
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(u.username, ''), NULLIF(u.display_name, ''), 'Anonym') AS author,
            r.stars AS stars, r.comment AS comment, r.updated_at AS updatedAt
       FROM ratings r JOIN users u ON u.id = r.user_id
       WHERE r.kiosk_id = ?
         AND u.banned_at IS NULL
         AND r.comment IS NOT NULL
         AND TRIM(r.comment) != ''
       ORDER BY r.updated_at DESC
       LIMIT ?`,
  )
    .bind(kioskId, limit)
    .all<RatingComment>();
  return results;
}

export async function upsertRating(
  env: Env,
  args: { kioskId: string; userId: string; stars: number; comment: string | null },
): Promise<void> {
  if (!Number.isInteger(args.stars) || args.stars < 1 || args.stars > 5) {
    throw new Error("stars must be 1..5");
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO ratings (kiosk_id, user_id, stars, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kiosk_id, user_id) DO UPDATE SET
         stars = excluded.stars,
         comment = excluded.comment,
         updated_at = excluded.updated_at`,
  )
    .bind(args.kioskId, args.userId, args.stars, args.comment, now, now)
    .run();
}

export async function deleteRating(env: Env, kioskId: string, userId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM ratings WHERE kiosk_id = ? AND user_id = ?`)
    .bind(kioskId, userId)
    .run();
}

export async function countRatings(env: Env): Promise<number> {
  // Banned users don't contribute to the public stats counter on /about.
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM ratings r JOIN users u ON u.id = r.user_id
       WHERE u.banned_at IS NULL`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}
