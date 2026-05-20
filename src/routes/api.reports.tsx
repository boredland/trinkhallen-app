import { Hono } from "hono";
import type { Env } from "../env";
import { getKioskById } from "../lib/db";

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

  // Reports sit in D1 with status='open' until a moderator approves on
  // /moderate. Approval is what opens the PR/issue — see lib/moderation.ts.
  return c.redirect(`/k/${kioskId}?reported=ok`);
});
