import { Hono } from "hono";
import { Layout } from "../components/Layout";
import type { Env } from "../env";
import { tagLabel } from "../lib/tags";
import {
  approveReport,
  approveSubmission,
  rejectReport,
  rejectSubmission,
} from "../lib/moderation";
import { getKioskById } from "../lib/asset-kiosks";

export const moderate = new Hono<{ Bindings: Env }>();

// ── role gate ───────────────────────────────────────────────────────────────

moderate.use("/moderate", requireModerator);
moderate.use("/api/moderate/*", requireModerator);

async function requireModerator(
  c: import("hono").Context<{ Bindings: Env }>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const user = c.get("user");
  if (!user) return c.redirect("/me?after=moderate");
  if (user.role !== "moderator" && user.role !== "admin") {
    return c.text("403 — moderator role required", 403);
  }
  await next();
}

// ── queue page ──────────────────────────────────────────────────────────────

interface PendingSubmissionRow {
  id: string;
  user_id: string;
  payload: string;
  status: string;
  pr_url: string | null;
  created_at: number;
  user_display_name: string | null;
  user_email: string;
}
interface PendingReportRow {
  id: string;
  kiosk_id: string;
  user_id: string;
  kind: string;
  payload: string | null;
  status: string;
  pr_url: string | null;
  created_at: number;
  kiosk_name: string;
  user_display_name: string | null;
  user_email: string;
}

moderate.get("/moderate", async (c) => {
  const user = c.get("user")!;
  const tab = (c.req.query("tab") ?? "submissions") as "submissions" | "reports";

  const [subs, reports] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT s.*, u.display_name AS user_display_name, u.email AS user_email
         FROM submissions s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.status = 'pending' ORDER BY s.created_at ASC LIMIT 100`,
      )
      .all<PendingSubmissionRow>(),
    c.env.DB
      .prepare(
        `SELECT r.*, u.display_name AS user_display_name, u.email AS user_email
         FROM reports r
         LEFT JOIN users u ON u.id = r.user_id
         WHERE r.status = 'open' ORDER BY r.created_at ASC LIMIT 100`,
      )
      .all<Omit<PendingReportRow, "kiosk_name">>(),
  ]);

  const reportKioskNames = new Map<string, string>();
  await Promise.all(
    [...new Set(reports.results.map((r) => r.kiosk_id))].map(async (id) => {
      const k = await getKioskById(c.env, id);
      if (k) reportKioskNames.set(id, k.name);
    }),
  );
  const reportRows: PendingReportRow[] = reports.results.map((r) => ({
    ...r,
    kiosk_name: reportKioskNames.get(r.kiosk_id) ?? r.kiosk_id,
  }));

  return c.html(
    <Layout title="Moderation" nav="me" user={user}>
      <header class="mb-6 flex items-end justify-between">
        <h1 class="font-display text-4xl tracking-wide text-fg">Moderation</h1>
        <p class="text-xs uppercase tracking-wider text-fg-dim">{user.role}</p>
      </header>

      <nav class="mb-6 flex gap-2 border-b-2 border-border">
        <TabLink href="/moderate?tab=submissions" active={tab === "submissions"} label={`Vorschläge (${subs.results.length})`} />
        <TabLink href="/moderate?tab=reports" active={tab === "reports"} label={`Korrekturen (${reportRows.length})`} />
      </nav>

      {tab === "submissions" ? (
        <SubmissionQueue rows={subs.results} />
      ) : (
        <ReportQueue rows={reportRows} />
      )}
    </Layout>,
  );
});

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <a
      href={href}
      class={`-mb-0.5 border-b-2 px-3 py-2 font-display text-sm tracking-wider uppercase transition-colors ${
        active
          ? "border-neon-pink text-neon-pink"
          : "border-transparent text-fg-muted hover:text-fg"
      }`}
    >
      {label}
    </a>
  );
}

function ApproveRejectForm({
  endpoint,
}: {
  endpoint: string;
}) {
  return (
    <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
      <form action={`${endpoint}/approve`} method="post">
        <button type="submit" class="btn-neon" style="background:#4ADE80;color:#0a0a0a">
          ✓ Approve
        </button>
      </form>
      <form action={`${endpoint}/reject`} method="post" class="flex flex-1 items-end gap-2">
        <label class="flex-1">
          <span class="sr-only">Begründung</span>
          <input
            type="text"
            name="note"
            placeholder="Begründung (optional)"
            class="w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none"
          />
        </label>
        <button
          type="submit"
          class="border-2 border-danger px-3 py-1.5 font-display text-sm tracking-wider uppercase text-danger hover:bg-danger hover:text-bg"
        >
          ✗ Reject
        </button>
      </form>
    </div>
  );
}

function SubmissionQueue({ rows }: { rows: PendingSubmissionRow[] }) {
  if (rows.length === 0) return <EmptyQueue label="Keine offenen Vorschläge." />;
  return (
    <ul class="space-y-4">
      {rows.map((s) => {
        const feature = JSON.parse(s.payload) as {
          geometry: { coordinates: [number, number] };
          properties: {
            name: string;
            description?: string;
            address?: Record<string, string>;
            hours?: { raw: string };
            tags?: string[];
            payment?: Record<string, string>;
          };
        };
        const [lng, lat] = feature.geometry.coordinates;
        const p = feature.properties;
        return (
          <li class="border-2 border-border bg-surface p-5">
            <header class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="font-display text-2xl tracking-wide text-fg">{p.name}</h2>
              <p class="text-xs text-fg-dim">
                von {s.user_display_name ?? s.user_email.split("@")[0]} ·{" "}
                {new Date(s.created_at * 1000).toLocaleDateString("de-DE")}
              </p>
            </header>
            <p class="mt-1 font-mono text-sm text-fg-muted">
              {lat.toFixed(5)}, {lng.toFixed(5)}
            </p>
            {p.address && (
              <p class="mt-2 text-sm text-fg-muted">
                {[p.address["street"], p.address["number"], p.address["postalcode"], p.address["city"]].filter(Boolean).join(" ")}
                {p.address["district"] && <span class="text-fg-dim"> · {p.address["district"]}</span>}
              </p>
            )}
            {p.description && <p class="mt-2 text-fg-muted">{p.description}</p>}
            {p.hours?.raw && <p class="mt-2 font-mono text-sm text-fg">{p.hours.raw}</p>}
            {p.tags && p.tags.length > 0 && (
              <ul class="mt-2 flex flex-wrap gap-1.5">
                {p.tags.map((t) => (
                  <li class="border-2 border-border-hi px-2 py-0.5 text-xs text-fg-muted">{tagLabel(t)}</li>
                ))}
              </ul>
            )}
            <details class="mt-3 text-xs">
              <summary class="cursor-pointer text-fg-dim hover:text-fg">JSON</summary>
              <pre class="mt-2 overflow-x-auto bg-surface-2 p-3 font-mono text-xs text-fg-muted">{JSON.stringify(feature, null, 2)}</pre>
            </details>
            <div class="mt-4">
              <ApproveRejectForm endpoint={`/api/moderate/submissions/${s.id}`} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ReportQueue({ rows }: { rows: PendingReportRow[] }) {
  if (rows.length === 0) return <EmptyQueue label="Keine offenen Korrekturen." />;
  return (
    <ul class="space-y-4">
      {rows.map((r) => {
        const payload = r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {};
        return (
          <li class="border-2 border-border bg-surface p-5">
            <header class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="font-display text-lg tracking-wide text-fg">
                <a class="hover:text-neon-pink" href={`/k/${r.kiosk_id}`}>
                  {r.kiosk_name}
                </a>
              </h2>
              <p class="text-xs text-fg-dim">
                von {r.user_display_name ?? r.user_email.split("@")[0]} ·{" "}
                {new Date(r.created_at * 1000).toLocaleDateString("de-DE")}
              </p>
            </header>
            <p class="mt-1 text-sm">
              <span class="border-2 border-border px-2 py-0.5 font-display text-xs tracking-wider uppercase text-neon-amber">
                {r.kind}
              </span>
            </p>
            <pre class="mt-3 overflow-x-auto bg-surface-2 p-3 font-mono text-xs text-fg-muted">{JSON.stringify(payload, null, 2)}</pre>
            <div class="mt-4">
              <ApproveRejectForm endpoint={`/api/moderate/reports/${r.id}`} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function EmptyQueue({ label }: { label: string }) {
  return (
    <div class="border-2 border-border bg-surface p-6 text-fg-muted">
      <p class="font-display text-xl tracking-wide text-fg">▶▶▶ Saubere Inbox</p>
      <p class="mt-2 text-sm">{label}</p>
    </div>
  );
}

// ── decision endpoints ──────────────────────────────────────────────────────

moderate.post("/api/moderate/submissions/:id/approve", async (c) => {
  const id = c.req.param("id");
  const moderator = c.get("user")!;
  const row = await c.env.DB
    .prepare(`SELECT * FROM submissions WHERE id = ? AND status = 'pending'`)
    .bind(id)
    .first<{
      id: string;
      user_id: string;
      payload: string;
      status: string;
      pr_url: string | null;
      created_at: number;
    }>();
  if (!row) return c.text("submission not pending", 404);
  await approveSubmission(c.env, row, moderator);
  return c.redirect("/moderate?tab=submissions");
});

moderate.post("/api/moderate/submissions/:id/reject", async (c) => {
  const id = c.req.param("id");
  const moderator = c.get("user")!;
  const note = (((await c.req.formData()).get("note") ?? "").toString().trim() || null);
  const row = await c.env.DB
    .prepare(`SELECT * FROM submissions WHERE id = ? AND status = 'pending'`)
    .bind(id)
    .first<{
      id: string;
      user_id: string;
      payload: string;
      status: string;
      pr_url: string | null;
      created_at: number;
    }>();
  if (!row) return c.text("submission not pending", 404);
  await rejectSubmission(c.env, row, moderator, note);
  return c.redirect("/moderate?tab=submissions");
});

moderate.post("/api/moderate/reports/:id/approve", async (c) => {
  const id = c.req.param("id");
  const moderator = c.get("user")!;
  const row = await c.env.DB
    .prepare(
      `SELECT * FROM reports WHERE id = ? AND status = 'open'`,
    )
    .bind(id)
    .first<{
      id: string;
      kiosk_id: string;
      user_id: string;
      kind: string;
      payload: string | null;
      status: string;
      pr_url: string | null;
      created_at: number;
    }>();
  if (!row) return c.text("report not actionable", 404);
  const kiosk = await getKioskById(c.env, row.kiosk_id);
  if (!kiosk) return c.text("report kiosk not found in dataset", 404);
  await approveReport(
    c.env,
    {
      id: row.id,
      kiosk_id: row.kiosk_id,
      user_id: row.user_id,
      kind: row.kind,
      payload: row.payload,
      status: row.status,
      pr_url: row.pr_url,
      created_at: row.created_at,
    },
    { id: kiosk.id, region: kiosk.region, name: kiosk.name },
    moderator,
  );
  return c.redirect("/moderate?tab=reports");
});

moderate.post("/api/moderate/reports/:id/reject", async (c) => {
  const id = c.req.param("id");
  const moderator = c.get("user")!;
  const note = (((await c.req.formData()).get("note") ?? "").toString().trim() || null);
  const row = await c.env.DB
    .prepare(`SELECT * FROM reports WHERE id = ? AND status = 'open'`)
    .bind(id)
    .first<{
      id: string;
      kiosk_id: string;
      user_id: string;
      kind: string;
      payload: string | null;
      status: string;
      pr_url: string | null;
      created_at: number;
    }>();
  if (!row) return c.text("report not pending", 404);
  await rejectReport(c.env, row, moderator, note);
  return c.redirect("/moderate?tab=reports");
});
