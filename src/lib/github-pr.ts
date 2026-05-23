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

/**
 * Read a file from a ref.
 *
 * The Contents API caps inline `content` at 1MB — files larger than that
 * come back with `encoding: "none"` and an empty `content` field, with the
 * blob SHA on the side. For those we fetch the actual bytes via the Git
 * Data API's blob endpoint (limit: 100MB, plenty for our geojsons).
 */
async function getFile(token: string, path: string, ref: string): Promise<FileGet | null> {
  const resp = await authedFetch(
    token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`getFile ${path}: HTTP ${resp.status}`);
  const data = (await resp.json()) as { content: string; encoding: string; sha: string };
  if (data.encoding === "base64") return { content: atobUtf8(data.content), sha: data.sha };
  if (data.encoding === "none") {
    const content = await getBlobContent(token, data.sha);
    return { content, sha: data.sha };
  }
  throw new Error(`getFile ${path}: unexpected encoding ${data.encoding}`);
}

async function getBlobContent(token: string, blobSha: string): Promise<string> {
  const resp = await authedFetch(
    token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/git/blobs/${blobSha}`,
  );
  if (!resp.ok) throw new Error(`getBlob ${blobSha}: HTTP ${resp.status}`);
  const data = (await resp.json()) as { content: string; encoding: string };
  if (data.encoding !== "base64") {
    throw new Error(`getBlob ${blobSha}: unexpected encoding ${data.encoding}`);
  }
  return atobUtf8(data.content);
}

/**
 * Write a file change on a fresh branch using the Git Data API.
 *
 * The Contents PUT endpoint has the same 1MB limit as the Contents GET, so
 * for our larger region files we drop down to the explicit blob → tree →
 * commit → ref dance. Trade-off: 4 round-trips instead of 1, but unconstrained
 * by file size and avoids the size-class branching that would otherwise have
 * to live in every caller.
 */
async function commitFileOnNewBranch(args: {
  token: string;
  path: string;
  branch: string;
  baseCommitSha: string;
  content: string;
  message: string;
}): Promise<void> {
  // 1. Upload the new file content as a blob.
  const blobResp = await authedFetch(
    args.token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/git/blobs`,
    {
      method: "POST",
      body: JSON.stringify({ content: args.content, encoding: "utf-8" }),
    },
  );
  if (!blobResp.ok) {
    const txt = await blobResp.text().catch(() => "");
    throw new Error(`createBlob: HTTP ${blobResp.status}: ${txt.slice(0, 200)}`);
  }
  const blob = (await blobResp.json()) as { sha: string };

  // 2. Get the base commit's tree SHA so we can build a delta tree.
  const baseCommitResp = await authedFetch(
    args.token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/git/commits/${args.baseCommitSha}`,
  );
  if (!baseCommitResp.ok) {
    throw new Error(`getCommit ${args.baseCommitSha}: HTTP ${baseCommitResp.status}`);
  }
  const baseCommit = (await baseCommitResp.json()) as { tree: { sha: string } };

  // 3. Create a tree that's `base_tree` plus our single-file change.
  const treeResp = await authedFetch(
    args.token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree: [{ path: args.path, mode: "100644", type: "blob", sha: blob.sha }],
      }),
    },
  );
  if (!treeResp.ok) {
    const txt = await treeResp.text().catch(() => "");
    throw new Error(`createTree: HTTP ${treeResp.status}: ${txt.slice(0, 200)}`);
  }
  const tree = (await treeResp.json()) as { sha: string };

  // 4. Wrap that tree in a commit, parented on the base commit.
  const commitResp = await authedFetch(
    args.token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({
        message: args.message,
        tree: tree.sha,
        parents: [args.baseCommitSha],
      }),
    },
  );
  if (!commitResp.ok) {
    const txt = await commitResp.text().catch(() => "");
    throw new Error(`createCommit: HTTP ${commitResp.status}: ${txt.slice(0, 200)}`);
  }
  const commit = (await commitResp.json()) as { sha: string };

  // 5. Create the branch ref pointing at the new commit. 422 = ref already
  //    exists from a prior failed attempt; force-update it so retries don't
  //    leave us stuck with stale state.
  const refResp = await authedFetch(
    args.token,
    `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/git/refs`,
    {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: commit.sha }),
    },
  );
  if (!refResp.ok) {
    if (refResp.status === 422) {
      const patchResp = await authedFetch(
        args.token,
        `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/git/refs/heads/${args.branch}`,
        {
          method: "PATCH",
          body: JSON.stringify({ sha: commit.sha, force: true }),
        },
      );
      if (!patchResp.ok) {
        const txt = await patchResp.text().catch(() => "");
        throw new Error(`updateRef ${args.branch}: HTTP ${patchResp.status}: ${txt.slice(0, 200)}`);
      }
      return;
    }
    const txt = await refResp.text().catch(() => "");
    throw new Error(`createRef ${args.branch}: HTTP ${refResp.status}: ${txt.slice(0, 200)}`);
  }
}

async function openPr(args: {
  token: string;
  branch: string;
  title: string;
  body: string;
}): Promise<CreatedPr> {
  const resp = await authedFetch(args.token, `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: args.title,
      body: args.body,
      head: args.branch,
      base: DEFAULT_BRANCH,
      draft: false,
    }),
  });
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
  const resp = await authedFetch(token, `/repos/${DATA_REPO_OWNER}/${DATA_REPO_NAME}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: args.title,
      body: args.body,
      ...(args.labels?.length ? { labels: args.labels } : {}),
    }),
  });
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

  const baseCommitSha = await getBranchSha(token, DEFAULT_BRANCH);
  await commitFileOnNewBranch({
    token,
    path: args.path,
    branch: args.branch,
    baseCommitSha,
    content: next,
    message: args.commitMessage,
  });

  return openPr({ token, branch: args.branch, title: args.prTitle, body: args.prBody });
}

// ── base64 helper that survives non-ASCII (German umlauts in the data) ──────

function atobUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
