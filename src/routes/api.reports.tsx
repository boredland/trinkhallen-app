import { Hono } from "hono";
import type { Env } from "../env";
import { getKioskById } from "../lib/asset-kiosks";
import { AMENITY_TAGS, isAmenityTag } from "../lib/tags";

export const apiReports = new Hono<{ Bindings: Env }>();

const ALLOWED_KINDS = new Set([
  "wrong_hours",
  "wrong_address",
  "wrong_name",
  "closed",
  "duplicate",
  "update_payment",
  "update_tags",
  "other",
]);

const PAYMENT_KEYS = ["cash", "cards", "contactless", "girocard", "mobile"] as const;
const PAYMENT_STATES = new Set(["yes", "no", "unknown"]);

apiReports.post("/api/reports", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Bitte anmelden.", 401);

  const form = await c.req.formData();
  const kioskId = (form.get("kiosk_id") ?? "").toString();
  const kind = (form.get("kind") ?? "").toString();
  if (!kioskId || !ALLOWED_KINDS.has(kind)) return c.text("Bad request", 400);

  const kiosk = await getKioskById(c.env, kioskId);
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
  if (kind === "wrong_name") {
    const name = (form.get("new_name") ?? "").toString().trim();
    if (name) payload["new_name"] = name.slice(0, 120);
  }
  if (kind === "update_payment") {
    // Whitelist both the key and the tri-state value so we don't persist
    // anything moderation.ts wouldn't know how to apply.
    const payment: Record<string, "yes" | "no" | "unknown"> = {};
    for (const key of PAYMENT_KEYS) {
      const v = (form.get(`pay_${key}`) ?? "").toString().trim();
      if (PAYMENT_STATES.has(v)) payment[key] = v as "yes" | "no" | "unknown";
    }
    if (Object.keys(payment).length > 0) payload["payment"] = payment;
  }
  if (kind === "update_tags") {
    // Field name convention: `tag_<slug>` = "yes" | "no" | "" (skip).
    const add: string[] = [];
    const remove: string[] = [];
    for (const slug of AMENITY_TAGS) {
      const v = (form.get(`tag_${slug}`) ?? "").toString();
      if (v === "yes" && isAmenityTag(slug)) add.push(slug);
      else if (v === "no" && isAmenityTag(slug)) remove.push(slug);
    }
    if (add.length) payload["add_tags"] = add;
    if (remove.length) payload["remove_tags"] = remove;
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO reports (id, kiosk_id, user_id, kind, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(id, kioskId, user.id, kind, JSON.stringify(payload), now, now)
    .run();

  // Reports sit in D1 with status='open' until a moderator approves on
  // /moderate. Approval is what opens the PR/issue — see lib/moderation.ts.
  //
  // Fragment submissions (gap-fill chip groups in CheckinForm — see
  // src/client/checkin.ts) get the HTML "Danke!" fragment for in-place swap.
  // Plain form submissions (legacy ReportForm "Daten falsch?") redirect.
  if (c.req.header("X-Tk-Fragment") === "1") {
    return c.html('<p class="text-sm italic text-fg-dim">Danke! Wir prüfen das.</p>');
  }
  return c.redirect(`/k/${kioskId}?reported=ok`);
});
