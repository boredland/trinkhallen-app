import { describe, expect, it } from "bun:test";
import app from "../index";

/**
 * CSRF coverage across locale mounts.
 *
 * Page routes and the moderation sub-app are mounted at both `/` and `/en`, so
 * any absolute-glob middleware (like csrf()) needs a per-locale twin or it
 * silently covers only one URL for the same handler.
 *
 * These tests assert that state-changing cross-origin requests are rejected with
 * 403 across both mounts.
 */

const env = {} as never;

function crossOriginPost(path: string) {
  return app.request(
    path,
    { method: "POST", headers: { origin: "https://evil.example" }, redirect: "manual" },
    env,
  );
}

describe("csrf middleware coverage across locale mounts", () => {
  it("rejects cross-origin POST /api/moderate/users/:id/ban with 403", async () => {
    const r = await crossOriginPost("/api/moderate/users/u1/ban");
    expect(r.status).toBe(403);
  });

  it("rejects cross-origin POST /en/api/moderate/users/:id/ban with 403", async () => {
    const r = await crossOriginPost("/en/api/moderate/users/u1/ban");
    expect(r.status).toBe(403);
  });

  it("rejects cross-origin POST /api/reports with 403", async () => {
    const r = await crossOriginPost("/api/reports");
    expect(r.status).toBe(403);
  });

  it("rejects cross-origin POST /en/api/reports with 403", async () => {
    const r = await crossOriginPost("/en/api/reports");
    expect(r.status).toBe(403);
  });
});
