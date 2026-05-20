/**
 * GitHub PR helpers built on the App-token plumbing in `github-app.ts`.
 *
 * High-level surface: `proposeChange()` — handles the full dance
 * (read file → mutate → commit on a fresh branch → open PR) so the
 * moderation layer just passes a mutator function.
 *
 * Falls back gracefully when no App creds are configured: returns null,
 * caller marks the row as 'approved (no PR)' so we don't lose moderator
 * intent before the GitHub App is provisioned.
 */

import type { Env } from "../env";
import { getInstallationToken, hasGithubAppCreds } from "./github-app";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "trinkhallen-app/1.0";
export const DATA_REPO_OWNER = "boredland";
export const DATA_REPO_NAME = "trinkhallen-data";
const DEFAULT_BRANCH = "main";

export interface CreatedPr {
  number: number;
  html_url: string;
}

interface FileGet {
  content: string; // base64-decoded UTF-8
  sha: string;
}

async function authedFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("user-agent", USER_AGENT);
  headers.set("x-github-api-version", "2022-11-28");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${GITHUB_API}${path}`, { ...init, headers });
}

async function getBranchSha(token: string, branch: string): Promise<string> {
  const resp = await authedFetch(
    token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/git/ref/heads/${branch}`,
  );
  if (!resp.ok) throw new Error(`getBranchSha ${branch}: HTTP ${resp.status}`);
  const data = (await resp.json()) as { object: { sha: string } };
  return data.object.sha;
}

async function getFile(token: string, path: string, ref: string): Promise<FileGet | null> {
  const resp = await authedFetch(
    token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`getFile ${path}: HTTP ${resp.status}`);
  const data = (await resp.json()) as { content: string; encoding: string; sha: string };
  if (data.encoding !== "base64") throw new Error(`unexpected encoding ${data.encoding}`);
  return { content: atobUtf8(data.content), sha: data.sha };
}

async function createBranch(token: string, branch: string, fromSha: string): Promise<void> {
  const resp = await authedFetch(token, `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  });
  if (!resp.ok && resp.status !== 422) {
    // 422 = ref already exists; we recover by using the existing branch.
    throw new Error(`createBranch ${branch}: HTTP ${resp.status}`);
  }
}

async function putFile(args: {
  token: string;
  path: string;
  branch: string;
  content: string;
  sha: string;
  message: string;
}): Promise<void> {
  const resp = await authedFetch(
    args.token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/contents/${encodeURIComponent(args.path)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: args.message,
        content: btoaUtf8(args.content),
        sha: args.sha,
        branch: args.branch,
      }),
    },
  );
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`putFile ${args.path}: HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
}

async function openPr(args: {
  token: string;
  branch: string;
  title: string;
  body: string;
}): Promise<CreatedPr> {
  const resp = await authedFetch(
    args.token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/pulls`,
    {
      method: "POST",
      body: JSON.stringify({
        title: args.title,
        body: args.body,
        head: args.branch,
        base: DEFAULT_BRANCH,
        draft: false,
      }),
    },
  );
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`openPr: HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { number: number; html_url: string };
  return { number: data.number, html_url: data.html_url };
}

export async function openIssueViaPr(
  env: Env,
  args: { title: string; body: string; labels?: string[] },
): Promise<CreatedPr | null> {
  if (!hasGithubAppCreds(env)) return null;
  const token = await getInstallationToken(env);
  const resp = await authedFetch(
    token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/issues`,
    {
      method: "POST",
      body: JSON.stringify({
        title: args.title,
        body: args.body,
        ...(args.labels?.length ? { labels: args.labels } : {}),
      }),
    },
  );
  if (!resp.ok) {
    console.error(`openIssueViaPr failed ${resp.status}`);
    return null;
  }
  const data = (await resp.json()) as { number: number; html_url: string };
  return { number: data.number, html_url: data.html_url };
}

/**
 * One-shot "propose a change to a single file" helper.
 *
 *  1. Fetch the file from `main`
 *  2. Run `mutate(currentText)` → new text
 *  3. If no actual change → return null (caller skips the PR)
 *  4. Create branch `head` off `main`
 *  5. PUT the new file content on that branch
 *  6. Open a PR
 */
export async function proposeChange(
  env: Env,
  args: {
    path: string;
    branch: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
    mutate: (currentText: string) => string;
  },
): Promise<CreatedPr | null> {
  if (!hasGithubAppCreds(env)) return null;
  const token = await getInstallationToken(env);

  const file = await getFile(token, args.path, DEFAULT_BRANCH);
  if (!file) {
    throw new Error(`Target file does not exist on ${DEFAULT_BRANCH}: ${args.path}`);
  }
  const next = args.mutate(file.content);
  if (next === file.content) return null;

  const baseSha = await getBranchSha(token, DEFAULT_BRANCH);
  await createBranch(token, args.branch, baseSha);

  // The file SHA on the new branch matches main's at this point.
  await putFile({
    token,
    path: args.path,
    branch: args.branch,
    content: next,
    sha: file.sha,
    message: args.commitMessage,
  });

  return openPr({ token, branch: args.branch, title: args.prTitle, body: args.prBody });
}

// ── base64 helpers that survive non-ASCII ───────────────────────────────────

function btoaUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function atobUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
