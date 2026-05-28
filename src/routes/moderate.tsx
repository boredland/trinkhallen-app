import { Hono } from "hono";
import { Layout } from "../components/Layout";
import type { Env } from "../env";
import { getKioskById } from "../lib/asset-kiosks";
import {
  approveReport,
  approveSubmission,
  rejectReport,
  rejectSubmission,
} from "../lib/moderation";
import { tagLabel } from "../lib/tags";

export const moderate = new Hono<{ Bindings: Env }>();

// ── role gate ───────────────────────────────────────────────────────────────

moderate.use("/moderate", requireModerator);
moderate.use("/api/moderate/*", requireModerator);

async function requireModerator(
  c: import("hono").Context<{ Bindings: Env }>,
  next: () => Promise<void>,
): Promise<Response | undefined> {
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
  user_username: string | null;
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
  user_username: string | null;
  user_email: string;
}
interface UserRow {
  id: string;
  email: string;
  username: string | null;
  role: "user" | "moderator" | "admin";
  banned_at: number | null;
  created_at: number;
  ratings_count: number;
  reports_count: number;
  submissions_count: number;
  checkins_count: number;
}
interface PendingAnomalyRow {
  id: string;
  user_id: string;
  kind: string;
  payload: string | null;
  created_at: number;
  user_username: string | null;
  user_email: string;
}

moderate.get("/moderate", async (c) => {
  const user = c.get("user")!;
  const tab = (c.req.query("tab") ?? "submissions") as
    | "submissions"
    | "reports"
    | "users"
    | "anomalies";

  const [subs, reports, users, anomalies] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.*, u.username AS user_username, u.email AS user_email
         FROM submissions s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.status = 'pending' ORDER BY s.created_at ASC LIMIT 100`,
    ).all<PendingSubmissionRow>(),
    c.env.DB.prepare(
      `SELECT r.*, u.username AS user_username, u.email AS user_email
         FROM reports r
         LEFT JOIN users u ON u.id = r.user_id
         WHERE r.status = 'open' ORDER BY r.created_at ASC LIMIT 100`,
    ).all<Omit<PendingReportRow, "kiosk_name">>(),
    c.env.DB.prepare(
      `SELECT
          u.id, u.email, u.username, u.role,
          u.banned_at, u.created_at,
          (SELECT COUNT(*) FROM ratings    r WHERE r.user_id = u.id) AS ratings_count,
          (SELECT COUNT(*) FROM reports    r WHERE r.user_id = u.id) AS reports_count,
          (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id) AS submissions_count,
          (SELECT COUNT(*) FROM checkins   c WHERE c.user_id = u.id) AS checkins_count
         FROM users u
         WHERE u.id != '00000000-0000-0000-0000-000000000000'
         ORDER BY u.banned_at IS NULL ASC, u.created_at DESC
         LIMIT 200`,
    ).all<UserRow>(),
    c.env.DB.prepare(
      `SELECT a.id, a.user_id, a.kind, a.payload, a.created_at,
              u.username AS user_username, u.email AS user_email
         FROM user_anomalies a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.reviewed_at IS NULL
         ORDER BY a.created_at DESC
         LIMIT 100`,
    ).all<PendingAnomalyRow>(),
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
    <Layout title="Moderation" noindex nav="me" user={user}>
      <header class="mb-6 flex items-end justify-between">
        <h1 class="font-display text-4xl tracking-wide text-fg">Moderation</h1>
        <p class="text-xs uppercase tracking-wider text-fg-dim">{user.role}</p>
      </header>

      <nav class="mb-6 flex gap-2 border-b-2 border-border">
        <TabLink
          href="/moderate?tab=submissions"
          active={tab === "submissions"}
          label={`Vorschläge (${subs.results.length})`}
        />
        <TabLink
          href="/moderate?tab=reports"
          active={tab === "reports"}
          label={`Korrekturen (${reportRows.length})`}
        />
        <TabLink
          href="/moderate?tab=users"
          active={tab === "users"}
          label={`Konten (${users.results.length})`}
        />
        <TabLink
          href="/moderate?tab=anomalies"
          active={tab === "anomalies"}
          label={`Anomalien (${anomalies.results.length})`}
        />
      </nav>

      {tab === "submissions" && <SubmissionQueue rows={subs.results} />}
      {tab === "reports" && <ReportQueue rows={reportRows} />}
      {tab === "users" && <UsersQueue rows={users.results} />}
      {tab === "anomalies" && <AnomaliesQueue rows={anomalies.results} />}
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

function ApproveRejectForm({ endpoint }: { endpoint: string }) {
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
                von {s.user_username ? `@${s.user_username}` : s.user_email.split("@")[0]} ·{" "}
                {new Date(s.created_at * 1000).toLocaleDateString("de-DE")}
              </p>
            </header>
            <p class="mt-1 font-mono text-sm text-fg-muted">
              {lat.toFixed(5)}, {lng.toFixed(5)}
            </p>
            {p.address && (
              <p class="mt-2 text-sm text-fg-muted">
                {[
                  p.address["street"],
                  p.address["number"],
                  p.address["postalcode"],
                  p.address["city"],
                ]
                  .filter(Boolean)
                  .join(" ")}
                {p.address["district"] && (
                  <span class="text-fg-dim"> · {p.address["district"]}</span>
                )}
              </p>
            )}
            {p.description && <p class="mt-2 text-fg-muted">{p.description}</p>}
            {p.hours?.raw && <p class="mt-2 font-mono text-sm text-fg">{p.hours.raw}</p>}
            {p.tags && p.tags.length > 0 && (
              <ul class="mt-2 flex flex-wrap gap-1.5">
                {p.tags.map((t) => (
                  <li class="border-2 border-border-hi px-2 py-0.5 text-xs text-fg-muted">
                    {tagLabel(t)}
                  </li>
                ))}
              </ul>
            )}
            <details class="mt-3 text-xs">
              <summary class="cursor-pointer text-fg-dim hover:text-fg">JSON</summary>
              <pre class="mt-2 overflow-x-auto bg-surface-2 p-3 font-mono text-xs text-fg-muted">
                {JSON.stringify(feature, null, 2)}
              </pre>
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
                von {r.user_username ? `@${r.user_username}` : r.user_email.split("@")[0]} ·{" "}
                {new Date(r.created_at * 1000).toLocaleDateString("de-DE")}
              </p>
            </header>
            <p class="mt-1 text-sm">
              <span class="border-2 border-border px-2 py-0.5 font-display text-xs tracking-wider uppercase text-neon-amber">
                {r.kind}
              </span>
            </p>
            <pre class="mt-3 overflow-x-auto bg-surface-2 p-3 font-mono text-xs text-fg-muted">
              {JSON.stringify(payload, null, 2)}
            </pre>
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

function UsersQueue({ rows }: { rows: UserRow[] }) {
  if (rows.length === 0) return <EmptyQueue label="Keine Konten." />;
  const fmt = (n: number) => new Date(n * 1000).toLocaleDateString("de-DE");
  return (
    <ul class="divide-y-2 divide-border border-2 border-border bg-surface">
      {rows.map((u) => {
        const banned = u.banned_at !== null;
        return (
          <li class={`flex flex-wrap items-center gap-4 p-4 ${banned ? "bg-danger/5" : ""}`}>
            <div class="min-w-0 flex-1">
              <p class="font-display text-sm tracking-wide text-fg">
                {u.username ? <span class="font-mono text-neon-cyan">@{u.username}</span> : u.email}
                {u.role !== "user" && (
                  <span class="ml-2 border border-border-hi px-1.5 py-0.5 text-xs uppercase tracking-wider text-fg-muted">
                    {u.role}
                  </span>
                )}
                {banned && (
                  <span class="ml-2 border-2 border-danger bg-danger/10 px-1.5 py-0.5 text-xs uppercase tracking-wider text-danger">
                    banned · {fmt(u.banned_at!)}
                  </span>
                )}
              </p>
              <p class="mt-1 text-xs text-fg-dim">
                {u.email} · seit {fmt(u.created_at)}
              </p>
              <p class="mt-1 text-xs font-mono tabular-nums text-fg-muted">
                ratings={u.ratings_count} · reports={u.reports_count} · submissions=
                {u.submissions_count} · checkins={u.checkins_count}
              </p>
            </div>
            <form action={`/api/moderate/users/${u.id}/${banned ? "unban" : "ban"}`} method="post">
              <button
                type="submit"
                class={
                  banned
                    ? "cursor-pointer border-2 border-neon-cyan px-3 py-1.5 font-display text-sm tracking-wide text-neon-cyan hover:bg-neon-cyan hover:text-bg"
                    : "cursor-pointer border-2 border-danger px-3 py-1.5 font-display text-sm tracking-wide text-danger hover:bg-danger hover:text-bg"
                }
              >
                {banned ? "Entbannen" : "Shadow-bannen"}
              </button>
            </form>
          </li>
        );
      })}
    </ul>
  );
}

function AnomaliesQueue({ rows }: { rows: PendingAnomalyRow[] }) {
  if (rows.length === 0) return <EmptyQueue label="Keine offenen Anomalien." />;
  return (
    <ul class="space-y-4">
      {rows.map((a) => {
        const payload = a.payload ? (JSON.parse(a.payload) as Record<string, unknown>) : {};
        return (
          <li class="border-2 border-border bg-surface p-5">
            <header class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="font-display text-lg tracking-wide text-fg">
                {a.user_username ? `@${a.user_username}` : a.user_email.split("@")[0]}
              </h2>
              <p class="text-xs text-fg-dim">
                <span class="border-2 border-border px-2 py-0.5 font-display text-xs tracking-wider uppercase text-neon-amber">
                  {a.kind}
                </span>{" "}
                · {new Date(a.created_at * 1000).toLocaleDateString("de-DE")}
              </p>
            </header>
            <pre class="mt-3 overflow-x-auto bg-surface-2 p-3 font-mono text-xs text-fg-muted">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </li>
        );
      })}
    </ul>
  );
}

// ── decision endpoints ──────────────────────────────────────────────────────

moderate.post("/api/moderate/submissions/:id/approve", async (c) => {
  const id = c.req.param("id");
  const moderator = c.get("user")!;
  const row = await c.env.DB.prepare(
    `SELECT * FROM submissions WHERE id = ? AND status = 'pending'`,
  )
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
  const note = ((await c.req.formData()).get("note") ?? "").toString().trim() || null;
  const row = await c.env.DB.prepare(
    `SELECT * FROM submissions WHERE id = ? AND status = 'pending'`,
  )
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
  const row = await c.env.DB.prepare(`SELECT * FROM reports WHERE id = ? AND status = 'open'`)
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
  try {
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
  } catch (err) {
    // Surface the underlying failure (GitHub API non-2xx, branch conflict,
    // missing feature, …) so the moderator UI shows something actionable
    // instead of a generic 500. Logs to wrangler tail too.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`approveReport(${row.id}) failed:`, msg);
    return c.text(`approve failed: ${msg}`, 500);
  }
  return c.redirect("/moderate?tab=reports");
});

moderate.post("/api/moderate/reports/:id/reject", async (c) => {
  const id = c.req.param("id");
  const moderator = c.get("user")!;
  const note = ((await c.req.formData()).get("note") ?? "").toString().trim() || null;
  const row = await c.env.DB.prepare(`SELECT * FROM reports WHERE id = ? AND status = 'open'`)
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

// ── shadow-ban ──────────────────────────────────────────────────────────────

const DELETED_USER_SENTINEL = "00000000-0000-0000-0000-000000000000";

moderate.post("/api/moderate/users/:id/ban", async (c) => {
  const id = c.req.param("id");
  if (id === DELETED_USER_SENTINEL) return c.text("cannot ban sentinel", 400);
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`UPDATE users SET banned_at = ? WHERE id = ? AND banned_at IS NULL`)
    .bind(now, id)
    .run();
  return c.redirect("/moderate?tab=users");
});

moderate.post("/api/moderate/users/:id/unban", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(`UPDATE users SET banned_at = NULL WHERE id = ?`).bind(id).run();
  return c.redirect("/moderate?tab=users");
});
