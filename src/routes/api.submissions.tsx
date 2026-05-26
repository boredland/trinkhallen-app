import { Hono } from "hono";
import type { Env } from "../env";

export const apiSubmissions = new Hono<{ Bindings: Env }>();

/**
 * POST /add (the form action) — validates a proposed Kiosk Feature, stores it
 * in submissions for moderator review. Mounted at `/add` rather than
 * `/api/submissions` so the form action is human-shareable.
 */
apiSubmissions.post("/add", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/me?after=add");

  const form = await c.req.formData();
  const lat = parseFloat((form.get("lat") ?? "").toString());
  const lng = parseFloat((form.get("lng") ?? "").toString());
  const name = (form.get("name") ?? "").toString().trim();
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.redirect("/add?error=basics");
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return c.redirect("/add?error=coords");
  }

  const properties: Record<string, unknown> = {
    name,
    address: stripUndefined({
      street: trim(form.get("street")),
      number: trim(form.get("number")),
      postalcode: postalcode(trim(form.get("postalcode"))),
      city: trim(form.get("city")),
      district: trim(form.get("district")),
    }),
  };
  const description = trim(form.get("description"));
  if (description) properties["description"] = description.slice(0, 2000);

  const hours = trim(form.get("hours_raw"));
  if (hours) properties["hours"] = { raw: hours.slice(0, 200) };

  // Multi-select tags arrive as repeated `tags` keys
  const tags = form
    .getAll("tags")
    .map((v) => v.toString())
    .filter(Boolean);
  if (tags.length) properties["tags"] = tags.slice(0, 30);

  const payment: Record<string, "yes" | "no" | "unknown"> = {};
  for (const key of ["cash", "cards", "contactless", "girocard"] as const) {
    const v = trim(form.get(`pay_${key}`));
    if (v === "yes" || v === "no" || v === "unknown") payment[key] = v;
  }
  if (Object.keys(payment).length) properties["payment"] = payment;

  const feature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties,
  };

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO submissions (id, user_id, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(id, user.id, JSON.stringify(feature), now, now)
    .run();

  // Submissions sit in D1 with status='pending' until a moderator approves
  // on /moderate. Approval is what opens the PR — see lib/moderation.ts.
  return c.redirect("/me?submitted=ok");
});

function trim(v: FormDataEntryValue | null): string {
  return v ? v.toString().trim() : "";
}

function postalcode(s: string): string | undefined {
  return /^\d{5}$/.test(s) ? s : undefined;
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== ""),
  ) as T;
}
