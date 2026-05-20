/**
 * Minimal GitHub App client for the Worker — enough to open issues against
 * `trinkhallen-data` on behalf of users. Auto-PR creation is a future
 * upgrade; for now moderators triage issues and open PRs manually.
 *
 * The App private key comes in as a PEM string in the GITHUB_APP_PRIVATE_KEY
 * secret. We import it once per request (Workers reset crypto handles
 * between executions; caching across requests would need Durable Objects
 * or a KV-stored installation token).
 */

import type { Env } from "../env";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "trinkhallen-app/1.0";
const DATA_REPO_OWNER = "boredland";
const DATA_REPO_NAME = "trinkhallen-data";

export function hasGithubAppCreds(env: Env): boolean {
  return !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID);
}

export interface CreatedIssue {
  number: number;
  html_url: string;
}

export async function openIssue(
  env: Env,
  args: { title: string; body: string; labels?: string[] },
): Promise<CreatedIssue | null> {
  if (!hasGithubAppCreds(env)) return null;

  const token = await getInstallationToken(env);
  const resp = await fetch(`${GITHUB_API}/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/issues`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      title: args.title,
      body: args.body,
      ...(args.labels?.length ? { labels: args.labels } : {}),
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error(`GitHub openIssue failed ${resp.status}: ${txt}`);
    return null;
  }
  const data = (await resp.json()) as { number: number; html_url: string };
  return { number: data.number, html_url: data.html_url };
}

// ── token plumbing ──────────────────────────────────────────────────────────

export async function getInstallationToken(env: Env): Promise<string> {
  const appJwt = await mintAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const resp = await fetch(
    `${GITHUB_API}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt}`,
        "user-agent": USER_AGENT,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`installation token exchange failed ${resp.status}: ${txt}`);
  }
  const data = (await resp.json()) as { token: string };
  return data.token;
}

async function mintAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60, // 9 min, GitHub max is 10
    iss: appId,
  };

  const enc = (obj: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${enc(header)}.${enc(payload)}`;

  const key = await importPkcs8(privateKeyPem);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = base64Decode(body);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Decode(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
