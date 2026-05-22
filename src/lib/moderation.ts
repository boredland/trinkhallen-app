/**
 * Approve / reject moderation decisions.
 *
 * `approveSubmission` and `approveReport` resolve the change, open a PR
 * via the GitHub App, and update the D1 row with the PR URL + status.
 *
 * Rejection is a single D1 update — no GitHub action.
 *
 * When the GitHub App isn't configured (`hasGithubAppCreds(env) === false`),
 * approvals still update D1 (status becomes "approved", pr_url left null) so
 * moderators can act now and we backfill PRs once the App is provisioned.
 */

import type { Env } from "../env";
import { hasGithubAppCreds } from "./github-app";
import { openIssueViaPr, proposeChange } from "./github-pr";
import { resolveRegionByCoords, resolveRegionByPath } from "./regions";

const APP_ORIGIN = "https://trinkhallen.app";

// ── shared types ────────────────────────────────────────────────────────────

interface Moderator {
  id: string;
  displayName: string | null;
  email: string;
}

export interface ApproveOutcome {
  status: "pr_opened" | "approved" | "rejected_invalid_region" | "skipped_no_change";
  prUrl?: string;
  prNumber?: number;
  note?: string;
}

// ── submissions ─────────────────────────────────────────────────────────────

interface Submission {
  id: string;
  user_id: string;
  payload: string; // JSON Feature
  status: string;
  pr_url: string | null;
  created_at: number;
}

interface ProposedFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    name: string;
    description?: string;
    address?: Record<string, string>;
    hours?: { raw: string };
    tags?: string[];
    payment?: Record<string, "yes" | "no" | "unknown">;
    [k: string]: unknown;
  };
}

export async function approveSubmission(
  env: Env,
  submission: Submission,
  moderator: Moderator,
): Promise<ApproveOutcome> {
  const feature = JSON.parse(submission.payload) as ProposedFeature;
  const [lng, lat] = feature.geometry.coordinates;

  const region = resolveRegionByCoords(lng, lat);
  if (!region) {
    await markSubmission(env, submission.id, {
      status: "dismissed",
      moderatorId: moderator.id,
      note: "region not yet covered — coordinates outside any configured region in regions.yml",
    });
    return {
      status: "rejected_invalid_region",
      note: "coordinates outside any covered region",
    };
  }

  // Generate a stable ID using submission id (already random uuid) — six chars is
  // collision-safe at our scale and keeps file IDs short.
  const shortId = submission.id.replace(/-/g, "").slice(0, 8);
  const newFeatureId = `tk_${region.prefix}_${shortId}`;

  const today = new Date().toISOString().slice(0, 10);
  const finalFeature = {
    type: "Feature" as const,
    geometry: feature.geometry,
    properties: {
      id: newFeatureId,
      name: feature.properties.name,
      ...(feature.properties.description ? { description: feature.properties.description } : {}),
      address: feature.properties.address ?? {},
      ...(feature.properties.hours ? { hours: feature.properties.hours } : {}),
      ...(feature.properties.tags ? { tags: feature.properties.tags } : {}),
      ...(feature.properties.payment ? { payment: feature.properties.payment } : {}),
      sources: [{ type: "user", id: submission.user_id }],
      created: today,
      updated: today,
    },
  };

  if (!hasGithubAppCreds(env)) {
    await markSubmission(env, submission.id, {
      status: "approved",
      moderatorId: moderator.id,
    });
    return {
      status: "approved",
      note: "approved in D1; PR not opened (GitHub App not configured)",
    };
  }

  const pr = await proposeChange(env, {
    path: region.path,
    branch: `prop/${shortId}`,
    commitMessage: `Add Späti "${feature.properties.name}" (${newFeatureId})`,
    prTitle: `Add Späti "${feature.properties.name}"`,
    prBody: renderSubmissionPrBody({
      submissionId: submission.id,
      featureId: newFeatureId,
      moderator,
      feature: finalFeature,
    }),
    mutate: (currentText) => appendFeatureToCollection(currentText, finalFeature),
  });

  if (!pr) {
    await markSubmission(env, submission.id, {
      status: "approved",
      moderatorId: moderator.id,
      note: "approved but proposeChange returned null (no diff)",
    });
    return { status: "skipped_no_change" };
  }

  await markSubmission(env, submission.id, {
    status: "pr_opened",
    moderatorId: moderator.id,
    prUrl: pr.html_url,
  });
  return { status: "pr_opened", prUrl: pr.html_url, prNumber: pr.number };
}

export async function rejectSubmission(
  env: Env,
  submission: Submission,
  moderator: Moderator,
  note: string | null,
): Promise<void> {
  await markSubmission(env, submission.id, {
    status: "dismissed",
    moderatorId: moderator.id,
    note,
  });
}

async function markSubmission(
  env: Env,
  id: string,
  patch: { status: string; moderatorId: string; prUrl?: string; note?: string | null },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE submissions SET
         status = ?,
         pr_url = COALESCE(?, pr_url),
         approved_by = ?,
         approved_at = ?,
         moderator_note = ?,
         updated_at = ?
       WHERE id = ?`,
  )
    .bind(patch.status, patch.prUrl ?? null, patch.moderatorId, now, patch.note ?? null, now, id)
    .run();
}

function appendFeatureToCollection(text: string, feature: unknown): string {
  const doc = JSON.parse(text) as { type: string; features: unknown[] };
  if (doc.type !== "FeatureCollection" || !Array.isArray(doc.features)) {
    throw new Error("target file is not a GeoJSON FeatureCollection");
  }
  doc.features.push(feature);
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function renderSubmissionPrBody(args: {
  submissionId: string;
  featureId: string;
  moderator: Moderator;
  feature: unknown;
}): string {
  return [
    `**Vorschlag**: \`${args.submissionId}\` → \`${args.featureId}\``,
    `**Approved by**: ${args.moderator.displayName ?? args.moderator.email.split("@")[0]}`,
    "",
    "Auto-generated by trinkhallen.app moderation. Merge to publish.",
    "",
    "<details><summary>Proposed Feature</summary>",
    "",
    "```json",
    JSON.stringify(args.feature, null, 2),
    "```",
    "",
    "</details>",
  ].join("\n");
}

// ── reports ─────────────────────────────────────────────────────────────────

interface Report {
  id: string;
  kiosk_id: string;
  user_id: string;
  kind: string;
  payload: string | null;
  status: string;
  pr_url: string | null;
  created_at: number;
}

interface KioskRow {
  id: string;
  region: string;
  name: string;
}

export async function approveReport(
  env: Env,
  report: Report,
  kiosk: KioskRow,
  moderator: Moderator,
): Promise<ApproveOutcome> {
  const payload = report.payload ? (JSON.parse(report.payload) as Record<string, unknown>) : {};

  // Reports whose change can't be encoded as a structured patch open an
  // ISSUE on the data repo (moderator triages manually). Those that can,
  // open a PR with the diff applied.
  if (report.kind === "duplicate" || report.kind === "other") {
    return openReportAsIssue(env, report, kiosk, moderator, payload);
  }

  // Map the kiosk's stored region back to a Region entry. The stored region
  // string carries the file's `data/<...>` path (set in seed/sync).
  const region =
    resolveRegionByPath(`${kiosk.region}.geojson`) ?? resolveRegionByPath(kiosk.region) ?? null;
  if (!region) {
    return openReportAsIssue(env, report, kiosk, moderator, payload);
  }

  if (!hasGithubAppCreds(env)) {
    await markReport(env, report.id, {
      status: "approved",
      moderatorId: moderator.id,
    });
    return {
      status: "approved",
      note: "approved in D1; PR not opened (GitHub App not configured)",
    };
  }

  const branch = `fix/${report.id.replace(/-/g, "").slice(0, 8)}`;
  const pr = await proposeChange(env, {
    path: region.path,
    branch,
    commitMessage: commitMessageForReport(report.kind, kiosk.name),
    prTitle: prTitleForReport(report.kind, kiosk.name),
    prBody: renderReportPrBody({ report, kiosk, moderator, payload }),
    mutate: (currentText) => applyReportPatch(currentText, kiosk.id, report.kind, payload),
  });

  if (!pr) {
    await markReport(env, report.id, {
      status: "approved",
      moderatorId: moderator.id,
      note: "approved but proposeChange returned null (no diff)",
    });
    return { status: "skipped_no_change" };
  }

  await markReport(env, report.id, {
    status: "pr_opened",
    moderatorId: moderator.id,
    prUrl: pr.html_url,
  });
  return { status: "pr_opened", prUrl: pr.html_url, prNumber: pr.number };
}

export async function rejectReport(
  env: Env,
  report: Report,
  moderator: Moderator,
  note: string | null,
): Promise<void> {
  await markReport(env, report.id, {
    status: "dismissed",
    moderatorId: moderator.id,
    note,
  });
}

async function openReportAsIssue(
  env: Env,
  report: Report,
  kiosk: KioskRow,
  moderator: Moderator,
  payload: Record<string, unknown>,
): Promise<ApproveOutcome> {
  if (!hasGithubAppCreds(env)) {
    await markReport(env, report.id, {
      status: "approved",
      moderatorId: moderator.id,
      note: "approved in D1 (no GitHub App); would have opened issue",
    });
    return { status: "approved" };
  }
  const issue = await openIssueViaPr(env, {
    title: `[${report.kind}] ${kiosk.name} (${kiosk.id})`,
    body: renderReportIssueBody({ report, kiosk, moderator, payload }),
    labels: ["report", report.kind],
  });
  if (!issue) {
    await markReport(env, report.id, {
      status: "approved",
      moderatorId: moderator.id,
      note: "issue creation failed; flagged as approved",
    });
    return { status: "approved" };
  }
  await markReport(env, report.id, {
    status: "pr_opened",
    moderatorId: moderator.id,
    prUrl: issue.html_url,
  });
  return { status: "pr_opened", prUrl: issue.html_url, prNumber: issue.number };
}

async function markReport(
  env: Env,
  id: string,
  patch: { status: string; moderatorId: string; prUrl?: string; note?: string | null },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE reports SET
         status = ?,
         pr_url = COALESCE(?, pr_url),
         approved_by = ?,
         approved_at = ?,
         moderator_note = ?,
         updated_at = ?
       WHERE id = ?`,
  )
    .bind(patch.status, patch.prUrl ?? null, patch.moderatorId, now, patch.note ?? null, now, id)
    .run();
}

function applyReportPatch(
  text: string,
  kioskId: string,
  kind: string,
  payload: Record<string, unknown>,
): string {
  const doc = JSON.parse(text) as {
    type: string;
    features: Array<{ properties: Record<string, unknown> }>;
  };
  if (doc.type !== "FeatureCollection" || !Array.isArray(doc.features)) {
    throw new Error("target file is not a GeoJSON FeatureCollection");
  }
  const idx = doc.features.findIndex((f) => (f.properties as { id?: string }).id === kioskId);
  if (idx < 0) throw new Error(`feature ${kioskId} not found in file`);
  const f = doc.features[idx]!;
  const today = new Date().toISOString().slice(0, 10);

  if (kind === "wrong_hours" && typeof payload["new_hours"] === "string") {
    f.properties["hours"] = { raw: payload["new_hours"] as string };
  } else if (
    kind === "wrong_address" &&
    payload["new_address"] &&
    typeof payload["new_address"] === "object"
  ) {
    const current = (f.properties["address"] as Record<string, string>) ?? {};
    f.properties["address"] = { ...current, ...(payload["new_address"] as Record<string, string>) };
  } else if (kind === "wrong_name" && typeof payload["new_name"] === "string") {
    f.properties["name"] = payload["new_name"];
  } else if (kind === "closed") {
    f.properties["closed"] = true;
  } else if (
    kind === "update_payment" &&
    payload["payment"] &&
    typeof payload["payment"] === "object"
  ) {
    // Conservative: only fill missing keys; never overwrite an existing value.
    // Mirrors run-gmaps-payment.ts's policy in the data repo — we'd rather
    // extend than argue with prior data.
    const current = (f.properties["payment"] as Record<string, string>) ?? {};
    const next = { ...current };
    for (const [k, v] of Object.entries(payload["payment"] as Record<string, string>)) {
      if (!next[k]) next[k] = v;
    }
    f.properties["payment"] = next;
  } else if (kind === "update_tags") {
    const tags = new Set((f.properties["tags"] as string[] | undefined) ?? []);
    for (const tag of (payload["add_tags"] as string[] | undefined) ?? []) tags.add(tag);
    for (const tag of (payload["remove_tags"] as string[] | undefined) ?? []) tags.delete(tag);
    f.properties["tags"] = [...tags];
  } else {
    throw new Error(`applyReportPatch: unsupported kind ${kind}`);
  }
  f.properties["updated"] = today;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function commitMessageForReport(kind: string, name: string): string {
  switch (kind) {
    case "wrong_hours":
      return `Fix opening hours for ${name}`;
    case "wrong_address":
      return `Fix address for ${name}`;
    case "wrong_name":
      return `Fix name for ${name}`;
    case "closed":
      return `Mark ${name} as closed`;
    case "update_payment":
      return `Fill in payment methods for ${name}`;
    case "update_tags":
      return `Update amenity tags for ${name}`;
    default:
      return `Update ${name} (${kind})`;
  }
}
function prTitleForReport(kind: string, name: string): string {
  return commitMessageForReport(kind, name);
}

function renderReportPrBody(args: {
  report: Report;
  kiosk: KioskRow;
  moderator: Moderator;
  payload: Record<string, unknown>;
}): string {
  return [
    `**Report**: \`${args.report.id}\` (kind \`${args.report.kind}\`)`,
    `**Kiosk**: [${args.kiosk.name}](${APP_ORIGIN}/k/${args.kiosk.id}) — \`${args.kiosk.id}\``,
    `**Approved by**: ${args.moderator.displayName ?? args.moderator.email.split("@")[0]}`,
    "",
    "<details><summary>User-supplied payload</summary>",
    "",
    "```json",
    JSON.stringify(args.payload, null, 2),
    "```",
    "",
    "</details>",
  ].join("\n");
}

function renderReportIssueBody(args: {
  report: Report;
  kiosk: KioskRow;
  moderator: Moderator;
  payload: Record<string, unknown>;
}): string {
  return [
    `**Report kind**: \`${args.report.kind}\` (auto-PR not applicable)`,
    `**Kiosk**: [${args.kiosk.name}](${APP_ORIGIN}/k/${args.kiosk.id}) — \`${args.kiosk.id}\``,
    `**Approved by**: ${args.moderator.displayName ?? args.moderator.email.split("@")[0]}`,
    "",
    "Moderator action: investigate and edit the relevant data file by hand.",
    "",
    "**User payload**",
    "```json",
    JSON.stringify(args.payload, null, 2),
    "```",
  ].join("\n");
}
