import { Hono } from "hono";
import type { Env } from "../env";
import { getKioskById } from "../lib/db";
import { hasGithubAppCreds, openIssue } from "../lib/github-app";

export const apiReports = new Hono<{ Bindings: Env }>();

const ALLOWED_KINDS = new Set(["wrong_hours", "wrong_address", "closed", "duplicate", "other"]);

apiReports.post("/api/reports", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Bitte anmelden.", 401);

  const form = await c.req.formData();
  const kioskId = (form.get("kiosk_id") ?? "").toString();
  const kind = (form.get("kind") ?? "").toString();
  if (!kioskId || !ALLOWED_KINDS.has(kind)) return c.text("Bad request", 400);

  const kiosk = await getKioskById(c.env.DB, kioskId);
  if (!kiosk) return c.text("Kiosk nicht gefunden", 404);

  // Capture per-kind structured payload so moderators see a one-glance diff.
  const payload: Record<string, unknown> = {};
  const note = (form.get("note") ?? "").toString().trim();
  if (note) payload["note"] = note.slice(0, 500);

  if (kind === "wrong_hours") {
    const hours = (form.get("new_hours") ?? "").toString().trim();
    if (hours) payload["new_hours"] = hours.slice(0, 200);
  }
  if (kind === "wrong_address") {
    const next: Record<string, string> = {};
    for (const key of ["new_street", "new_number", "new_postalcode", "new_city"] as const) {
      const v = (form.get(key) ?? "").toString().trim();
      if (v) next[key.replace("new_", "")] = v;
    }
    if (Object.keys(next).length > 0) payload["new_address"] = next;
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB
    .prepare(
      `INSERT INTO reports (id, kiosk_id, user_id, kind, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .bind(id, kioskId, user.id, kind, JSON.stringify(payload), now, now)
    .run();

  // Open a GitHub issue if the App is configured — fire-and-forget so the
  // user gets their redirect immediately. The webhook on PR/issue close
  // later updates `reports.status`.
  if (hasGithubAppCreds(c.env)) {
    c.executionCtx.waitUntil(
      (async () => {
        const issue = await openIssue(c.env, {
          title: `[${kind}] ${kiosk.name} (${kiosk.id})`,
          body: renderReportIssueBody({ kioskId, kiosk, kind, payload, reportId: id }),
          labels: ["report", kind],
        });
        if (issue) {
          await c.env.DB
            .prepare(`UPDATE reports SET pr_url = ?, status = 'pr_opened' WHERE id = ?`)
            .bind(issue.html_url, id)
            .run();
        }
      })(),
    );
  }

  return c.redirect(`/k/${kioskId}?reported=ok`);
});

function renderReportIssueBody(args: {
  kioskId: string;
  kiosk: { name: string };
  kind: string;
  payload: Record<string, unknown>;
  reportId: string;
}): string {
  const lines: string[] = [
    `**Kiosk**: \`${args.kioskId}\` — ${args.kiosk.name}`,
    `**Kind**: \`${args.kind}\``,
    `**Report ID**: \`${args.reportId}\``,
    "",
    "**Payload**",
    "```json",
    JSON.stringify(args.payload, null, 2),
    "```",
    "",
    `_Filed via trinkhallen.app. Moderator action: edit the relevant geojson under \`data/**\` and merge, then close this issue._`,
  ];
  return lines.join("\n");
}
