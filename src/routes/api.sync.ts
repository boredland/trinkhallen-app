import { Hono } from "hono";
import type { Env } from "../env";
import { fetchRawFile, verifyWebhookSignature } from "../lib/github";
import { regionFromPath, syncRegion, type FeatureCollection } from "../lib/sync";

export const apiSync = new Hono<{ Bindings: Env }>();

interface GitHubPushPayload {
  ref: string;
  repository: { full_name: string; owner: { login: string }; name: string };
  commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
  head_commit?: { id: string };
}

/**
 * POST /api/sync
 *
 * GitHub webhook receiver. Verifies the X-Hub-Signature-256, walks the push
 * commits for any changed `data/**.geojson` files, fetches each at the new ref,
 * and re-syncs the corresponding region. Deletions ripple through because
 * `syncRegion` is an authoritative replace.
 */
apiSync.post("/api/sync", async (c) => {
  const signature = c.req.header("x-hub-signature-256") ?? null;
  const event = c.req.header("x-github-event") ?? "";
  const rawBody = await c.req.text();

  if (!c.env.GITHUB_WEBHOOK_SECRET) {
    return c.json({ error: "webhook secret not configured" }, 500);
  }

  const ok = await verifyWebhookSignature(rawBody, signature, c.env.GITHUB_WEBHOOK_SECRET);
  if (!ok) return c.json({ error: "invalid signature" }, 401);

  if (event === "ping") return c.json({ pong: true });
  if (event !== "push") return c.json({ skipped: `unsupported event ${event}` }, 202);

  const payload = JSON.parse(rawBody) as GitHubPushPayload;
  const ref = payload.head_commit?.id;
  if (!ref) return c.json({ error: "no head_commit" }, 400);

  const changed = new Set<string>();
  for (const commit of payload.commits ?? []) {
    for (const p of [...(commit.added ?? []), ...(commit.modified ?? [])]) {
      if (p.startsWith("data/") && p.endsWith(".geojson")) changed.add(p);
    }
    for (const p of commit.removed ?? []) {
      if (p.startsWith("data/") && p.endsWith(".geojson")) changed.add(p);
    }
  }

  if (changed.size === 0) return c.json({ skipped: "no data/**.geojson changes" });

  const [owner, repo] = payload.repository.full_name.split("/");
  if (!owner || !repo) return c.json({ error: "bad repo name" }, 400);

  const results = [];
  for (const path of changed) {
    const region = regionFromPath(path);
    if (!region) continue;
    try {
      const body = await fetchRawFile(owner, repo, ref, path);
      const collection = JSON.parse(body) as FeatureCollection;
      const stats = await syncRegion(c.env.DB, region, collection);
      results.push(stats);
    } catch (err) {
      results.push({ region, error: (err as Error).message });
    }
  }

  return c.json({ ref, results });
});
