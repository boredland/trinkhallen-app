/**
 * Cloudflare Turnstile verification for the magic-link signup form.
 *
 * Added after a bot campaign (2026-07-02 → 07-26) minted 613 login mails to
 * harvested corporate addresses from 42 datacenter IPs, creating 142 accounts.
 * The per-email cap in magic.ts doesn't constrain an attacker walking a list of
 * distinct addresses, so the gate has to prove a human is on the other end.
 *
 * Verification is server-side in the /auth/magic handler rather than in the
 * browser: the form is a plain POST with no JS, and a client-side check would
 * be bypassed by posting straight to the endpoint — exactly what the bot did.
 *
 * An empty TURNSTILE_SECRET_KEY disables the gate, so local dev and any deploy
 * predating the secret keep working. This mirrors how the Google/Apple handlers
 * degrade when their credentials are absent.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const TURNSTILE_FIELD = "cf-turnstile-response";

/**
 * Verifies a widget token against siteverify. Returns false on a missing token,
 * a rejected token, or a siteverify outage — the endpoint sends mail to
 * arbitrary addresses, so an unverifiable request must not pass.
 */
export async function verifyTurnstile(
  env: { TURNSTILE_SECRET_KEY?: string },
  token: string | null,
  remoteIp: string | null,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) {
      console.error("turnstile siteverify http error", res.status);
      return false;
    }
    const outcome = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!outcome.success) {
      console.warn("turnstile rejected", outcome["error-codes"]);
      return false;
    }
    return true;
  } catch (err) {
    console.error("turnstile siteverify failed", err);
    return false;
  }
}
