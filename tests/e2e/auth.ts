/**
 * Auth helpers for e2e tests.
 *
 * Mirrors the session-cookie shape from `src/lib/session.ts`:
 *   - cookie name: `__Host-tk_sess`
 *   - value: `<sid>.<hmac>` where hmac = HMAC-SHA256(sid, SESSION_SECRET)
 *     encoded as base64url (Node's `digest('base64url')` matches the worker's
 *     `bufferToBase64Url` helper character-for-character).
 *
 * `seedTestUser` inserts a fresh users + sessions row pair via
 * `wrangler d1 execute --local`. The caller is responsible for cleanup via
 * `deleteTestUser` (usually in a try/finally so a failing assertion doesn't
 * leave stray rows behind).
 */

import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { BrowserContext } from "@playwright/test";

const COOKIE_NAME = "__Host-tk_sess";

function readSessionSecret(): string {
  if (!existsSync(".dev.vars")) {
    throw new Error("e2e auth helper: .dev.vars missing — global-setup should have created it");
  }
  const raw = readFileSync(".dev.vars", "utf8");
  const match = raw.match(/^SESSION_SECRET=(.+)$/m);
  if (!match) throw new Error("e2e auth helper: .dev.vars has no SESSION_SECRET line");
  return match[1]!.trim().replace(/^["']|["']$/g, "");
}

function d1Exec(sql: string): void {
  execFileSync(
    "bunx",
    ["wrangler", "d1", "execute", "trinkhallen-prod", "--local", "--command", sql],
    { stdio: "pipe" },
  );
}

function signSid(sid: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(sid).digest("base64url");
  return `${sid}.${mac}`;
}

export interface SeededUser {
  userId: string;
  email: string;
  username: string;
  cookieValue: string;
}

export function seedTestUser(): SeededUser {
  const secret = readSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const userId = `u-test-${randomBytes(8).toString("hex")}`;
  const sid = randomBytes(32).toString("hex");
  const tag = randomBytes(4).toString("hex");
  const email = `test-${tag}@trinkhallen.app`;
  const username = `tester_${tag}`;

  // One d1Exec, not two: each call spawns a fresh `wrangler` (~seconds of
  // startup), so the round-trip — not the query — is the cost. Both rows in a
  // single semicolon-separated command halves the per-seed wall-clock.
  d1Exec(
    `INSERT INTO users (id, google_sub, email, role, created_at, username)
       VALUES ('${userId}', 'email:${email}', '${email}', 'user', ${now}, '${username}');
     INSERT INTO sessions (id, user_id, expires_at, created_at)
       VALUES ('${sid}', '${userId}', ${now + 3600}, ${now});`,
  );

  return { userId, email, username, cookieValue: signSid(sid, secret) };
}

export async function setSessionCookie(
  context: BrowserContext,
  cookieValue: string,
  baseURL = "https://127.0.0.1:5173",
): Promise<void> {
  // __Host-tk_sess requires Secure + Path=/ + no Domain. Browsers treat
  // 127.0.0.1 as a secure origin so this is accepted even over http.
  // Playwright takes either `url` OR `domain+path`. `url` covers path=/ and
  // 127.0.0.1 is treated as a secure origin so the __Host- prefix is honoured.
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: cookieValue,
      url: baseURL,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

export function deleteTestUser(userId: string): void {
  d1Exec(
    `DELETE FROM sessions WHERE user_id = '${userId}';
     DELETE FROM users WHERE id = '${userId}';`,
  );
}
