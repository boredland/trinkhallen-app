import { describe, expect, it } from "bun:test";
import app from "../index";

/**
 * First-visit language detection + the switcher's sticky `?setlang`. All the
 * cases here resolve in the language middleware before any handler touches D1,
 * so an empty env is enough — we only assert status + Location/Set-Cookie.
 */

const env = {} as never;

function req(path: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers, redirect: "manual" }, env);
}

describe("language middleware", () => {
  it("redirects an English-preferring first visit on / to /en", async () => {
    const r = await req("/", { "accept-language": "en-US,en;q=0.9" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/en");
    expect(r.headers.get("set-cookie") ?? "").toContain("tk_lang=en");
  });

  it("leaves a German-preferring first visit on /", async () => {
    // No redirect → falls through to the handler, which fails on the empty env.
    // A 302 here would be the bug we're guarding against; anything else is fine.
    const r = await req("/", { "accept-language": "de-DE,de;q=0.9" });
    expect(r.status).not.toBe(302);
  });

  it("never bounces an explicit /en URL (crawler / shared link safe)", async () => {
    const r = await req("/en", { "accept-language": "de-DE,de;q=0.9" });
    expect(r.status).not.toBe(302);
  });

  it("does not redirect a crawler with no Accept-Language on /", async () => {
    const r = await req("/");
    expect(r.status).not.toBe(302);
  });

  it("honours a saved English cookie on / even with German Accept-Language", async () => {
    const r = await req("/", { "accept-language": "de-DE", cookie: "tk_lang=en" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/en");
  });

  it("honours a saved German cookie on / (no bounce) despite English Accept-Language", async () => {
    const r = await req("/", { "accept-language": "en-US", cookie: "tk_lang=de" });
    expect(r.status).not.toBe(302);
  });

  it("preserves the query string when auto-redirecting", async () => {
    const r = await req("/?c=50.11,8.68&z=14", { "accept-language": "en" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/?c=50.11,8.68&z=14".replace("/", "/en"));
  });

  it("setlang persists the choice and bounces to the clean URL", async () => {
    const r = await req("/en?setlang=de");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    expect(r.headers.get("set-cookie") ?? "").toContain("tk_lang=de");
  });

  it("setlang=en from a German page redirects to the /en clean URL", async () => {
    const r = await req("/k/abc123?setlang=en");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/en/k/abc123");
    expect(r.headers.get("set-cookie") ?? "").toContain("tk_lang=en");
  });

  it("does not redirect partial fetches", async () => {
    const r = await req("/k/abc123?partial=1", { "accept-language": "en" });
    expect(r.status).not.toBe(302);
  });
});
