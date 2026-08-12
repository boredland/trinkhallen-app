import { describe, expect, it } from "bun:test";
import type { Env } from "../env";
import { buildReportEmail, notifyNewReport, type ReportNotification } from "./notify";

const REPORT: ReportNotification = {
  id: "r-1",
  kioskId: "tk_fr_0001",
  kioskName: "Wasserhäuschen Bockenheim",
  kind: "wrong_hours",
  payload: { note: "Macht schon um 20 Uhr zu", hours_raw: "Mo-Sa 08:00-20:00" },
  reporter: "@boredland",
};

function makeCtx(): { ctx: ExecutionContext; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

const ENV = {
  PUBLIC_ORIGIN: "https://trinkhallen.app",
  REPORT_NOTIFY_TO: "ops@example.com",
} satisfies Pick<Env, "PUBLIC_ORIGIN" | "REPORT_NOTIFY_TO">;

describe("buildReportEmail", () => {
  it("puts the translated kind and kiosk name in the subject", () => {
    const mail = buildReportEmail(ENV, REPORT);
    expect(mail.subject).toBe("Neue Meldung: Öffnungszeiten — Wasserhäuschen Bockenheim");
  });

  it("links the moderation queue and the kiosk page", () => {
    const mail = buildReportEmail(ENV, REPORT);
    expect(mail.text).toContain("https://trinkhallen.app/moderate?tab=reports");
    expect(mail.text).toContain("https://trinkhallen.app/k/tk_fr_0001");
    expect(mail.html).toContain("https://trinkhallen.app/moderate?tab=reports");
  });

  it("carries the reporter and the full payload", () => {
    const mail = buildReportEmail(ENV, REPORT);
    expect(mail.text).toContain("@boredland");
    expect(mail.text).toContain("Mo-Sa 08:00-20:00");
  });

  it("escapes user-controlled strings in the HTML part", () => {
    const mail = buildReportEmail(ENV, {
      ...REPORT,
      kioskName: 'Späti <script>alert("x")</script>',
      payload: { note: "<img src=x onerror=alert(1)>" },
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("omits the quote block when the report carries no note", () => {
    const mail = buildReportEmail(ENV, { ...REPORT, payload: {} });
    expect(mail.html).not.toContain("blockquote");
  });
});

describe("notifyNewReport", () => {
  it("addresses the mail to REPORT_NOTIFY_TO", () => {
    expect(buildReportEmail(ENV, REPORT).to).toBe("ops@example.com");
  });

  it("queues nothing when REPORT_NOTIFY_TO is unset", () => {
    const { ctx, pending } = makeCtx();
    notifyNewReport({ ...ENV, REPORT_NOTIFY_TO: "" } as unknown as Env, ctx, REPORT);
    expect(pending).toHaveLength(0);
  });

  it("defers the send and swallows failures — a broken mail hop must not fail the report write", async () => {
    const { ctx, pending } = makeCtx();
    notifyNewReport(ENV as unknown as Env, ctx, REPORT);
    expect(pending).toHaveLength(1);
    // sendEmail rejects here (cloudflare:email is workerd-only), which is
    // exactly the failure mode the catch exists for.
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});
