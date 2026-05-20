/**
 * GitHub helpers for the data sync webhook + (later) PR creation via App tokens.
 * Webhook signature verification follows GitHub's `X-Hub-Signature-256` spec.
 */

const encoder = new TextEncoder();

/**
 * Verify a GitHub webhook payload signature.
 * GitHub sends: `X-Hub-Signature-256: sha256=<hex hmac>`.
 * Uses `crypto.subtle` (available in the Workers runtime).
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = bufferToHex(sig);

  return timingSafeEqual(provided, expected);
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Fetch the contents of a file from a public GitHub repo at a specific ref.
 * Used by the sync handler to pull the post-merge state of changed data files.
 */
export async function fetchRawFile(
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  const resp = await fetch(url, { headers: { "User-Agent": "trinkhallen-app/1.0" } });
  if (!resp.ok) throw new Error(`GitHub raw fetch ${url} failed: HTTP ${resp.status}`);
  return resp.text();
}
