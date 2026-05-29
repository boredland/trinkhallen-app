import { describe, expect, it } from "bun:test";
import app from "../index";

/**
 * First-visit language detection + the switcher's sticky `?setlang`.
 *
 * Redirect cases short-circuit in the middleware before any handler runs, so an
 * empty env is enough. The "no redirect" cases deliberately target /impressum —
 * a static page that doesn't touch D1/ASSETS — so they render a clean 200
 * instead of falling through to a binding-dependent handler.
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

  it("leaves a German-preferring first visit on a default-locale page", async () => {
    const r = await req("/impressum", { "accept-language": "de-DE,de;q=0.9" });
    expect(r.status).toBe(200);
  });

  it("never bounces an explicit /en URL (crawler / shared link safe)", async () => {
    const r = await req("/en/impressum", { "accept-language": "de-DE,de;q=0.9" });
    expect(r.status).toBe(200);
  });

  it("does not redirect a crawler with no Accept-Language", async () => {
    const r = await req("/impressum");
    expect(r.status).toBe(200);
  });

  it("honours a saved English cookie on / even with German Accept-Language", async () => {
    const r = await req("/", { "accept-language": "de-DE", cookie: "tk_lang=en" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/en");
  });

  it("honours a saved German cookie (no bounce) despite English Accept-Language", async () => {
    const r = await req("/impressum", { "accept-language": "en-US", cookie: "tk_lang=de" });
    expect(r.status).toBe(200);
  });

  it("preserves the query string when auto-redirecting", async () => {
    const r = await req("/?c=50.11,8.68&z=14", { "accept-language": "en" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/en?c=50.11,8.68&z=14");
  });

  it("setlang persists the choice and bounces to the clean URL", async () => {
    const r = await req("/en?setlang=de");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    expect(r.headers.get("set-cookie") ?? "").toContain("tk_lang=de");
  });

  it("setlang=en from a German page redirects to the /en clean URL", async () => {
    const r = await req("/impressum?setlang=en");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/en/impressum");
    expect(r.headers.get("set-cookie") ?? "").toContain("tk_lang=en");
  });

  it("does not redirect partial fetches", async () => {
    const r = await req("/impressum?partial=1", { "accept-language": "en" });
    expect(r.status).toBe(200);
  });
});
