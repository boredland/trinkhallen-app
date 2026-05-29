import type { Env } from "../env";

/**
 * Sentinel ID for the "Gelöschtes Konto" row that hand-deleted accounts
 * get repointed to (see migrations/0008_delete_ban.sql). Excluded from
 * public counts so it doesn't inflate the user total.
 */
export const DELETED_USER_SENTINEL = "00000000-0000-0000-0000-000000000000";

/**
 * Count of "real" registered accounts for the /about stats block.
 * Mirrors the convention in countRatings: banned users and the
 * deleted-account sentinel don't contribute.
 */
export async function countUsers(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM users
       WHERE banned_at IS NULL
         AND id != ?`,
  )
    .bind(DELETED_USER_SENTINEL)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
