/**
 * Sign in with Apple — server-side helpers.
 *
 * Apple's OAuth flow is mostly standard, with three wrinkles vs Google:
 *
 *   1. The callback is a `POST application/x-www-form-urlencoded` from
 *      appleid.apple.com (cross-site), not a GET. We rely on a
 *      SameSite=None state cookie for CSRF.
 *
 *   2. The `client_secret` we send to /auth/token is a short-lived ES256
 *      JWT signed with our Sign-In private key (.p8). Apple does not
 *      issue a static client secret. We mint a fresh JWT per token
 *      exchange.
 *
 *   3. The id_token carries `sub` + `email` on every sign-in. Apple also
 *      POSTs an optional `user` form field on the very first sign-in with
 *      the name, but we don't request the `name` scope and don't read it.
 *
 * Apple's `email` may be a relay address ("…@privaterelay.appleid.com")
 * if the user picked "Hide My Email". Treat it as their real email —
 * Apple forwards to the real one transparently.
 */

import type { Env } from "../env";

const APPLE_AUDIENCE = "https://appleid.apple.com";
const TOKEN_URL = "https://appleid.apple.com/auth/token";
const AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";

export interface AppleEnv {
  servicesId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
}

/**
 * Pulls the Apple Sign-In credential set off `env`, returning null if any
 * one of the four secrets is missing. Lets callers short-circuit with a
 * "not configured" message instead of erroring deep in the JWT signer.
 */
export function appleEnv(env: Env): AppleEnv | null {
  const {
    APPLE_SIGN_IN_SERVICES_ID,
    APPLE_SIGN_IN_TEAM_ID,
    APPLE_SIGN_IN_KEY_ID,
    APPLE_SIGN_IN_PRIVATE_KEY,
  } = env;
  if (
    !APPLE_SIGN_IN_SERVICES_ID ||
    !APPLE_SIGN_IN_TEAM_ID ||
    !APPLE_SIGN_IN_KEY_ID ||
    !APPLE_SIGN_IN_PRIVATE_KEY
  ) {
    return null;
  }
  return {
    servicesId: APPLE_SIGN_IN_SERVICES_ID,
    teamId: APPLE_SIGN_IN_TEAM_ID,
    keyId: APPLE_SIGN_IN_KEY_ID,
    privateKeyPem: APPLE_SIGN_IN_PRIVATE_KEY,
  };
}

/**
 * Builds the URL the browser is redirected to so the user can authorize
 * us on appleid.apple.com.
 *
 * `response_mode=form_post` is mandatory whenever an `email`/`name` scope is
 * requested so Apple can POST the result back in the body; query-string mode
 * strips it. The trade-off is the cross-site POST, which requires a
 * SameSite=None state cookie (set by the caller). We request only `email` —
 * the name is not collected.
 */
export function buildAuthorizeUrl(apple: AppleEnv, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: apple.servicesId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "form_post",
    scope: "email",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Mints the ES256 JWT we use as `client_secret` when exchanging the
 * authorization code at /auth/token. Lifetime is 5 minutes — well under
 * Apple's 6-month max but plenty for the one round-trip we need.
 */
async function mintClientSecret(apple: AppleEnv): Promise<string> {
  const key = await importPkcs8(apple.privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: apple.keyId, typ: "JWT" };
  const payload = {
    iss: apple.teamId,
    iat: now,
    exp: now + 300,
    aud: APPLE_AUDIENCE,
    sub: apple.servicesId,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${b64url(sig)}`;
}

/**
 * Apple id_token shape we care about. The token is signed by Apple with
 * their JWKS; we trust it because we just exchanged it server-to-server
 * over HTTPS, so we decode without signature verification (defense in
 * depth would fetch https://appleid.apple.com/auth/keys, but that's a
 * second round-trip per login for marginal added safety).
 */
export interface AppleIdToken {
  sub: string;
  email?: string;
  email_verified?: boolean | "true" | "false";
  is_private_email?: boolean | "true" | "false";
}

/**
 * Exchanges the authorization code Apple POSTed to us for an id_token
 * we can trust. Returns the decoded id_token payload.
 */
export async function exchangeCode(
  apple: AppleEnv,
  code: string,
  redirectUri: string,
): Promise<AppleIdToken> {
  const clientSecret = await mintClientSecret(apple);
  const body = new URLSearchParams({
    client_id: apple.servicesId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`apple /auth/token returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("apple /auth/token returned no id_token");
  return decodeIdToken(json.id_token);
}

function decodeIdToken(jwt: string): AppleIdToken {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  const payloadB64 = parts[1]!;
  const padded = payloadB64
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(payloadB64.length / 4) * 4, "=");
  return JSON.parse(atob(padded)) as AppleIdToken;
}

function b64url(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bytes = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
}

/**
 * Form-post payload shape Apple sends to our callback. Everything except
 * `code` is optional in practice — `state` is what we sent, `user` only
 * arrives on the first sign-in for that Apple ID, `id_token` is a copy
 * of the same token we'll receive from /auth/token (don't trust the
 * form one; only the /auth/token-derived id_token is exchanged via our
 * client_secret JWT and therefore proves Apple is the issuer).
 */
export interface AppleCallbackForm {
  code: string;
  state: string | null;
  id_token: string | null;
  error: string | null;
}

export function parseCallbackForm(form: FormData): AppleCallbackForm {
  return {
    code: (form.get("code") ?? "").toString(),
    state: form.get("state") ? form.get("state")!.toString() : null,
    id_token: form.get("id_token") ? form.get("id_token")!.toString() : null,
    error: form.get("error") ? form.get("error")!.toString() : null,
  };
}
