/**
 * Behavioural tests for the SW private-paths matcher. Confirms per-user and
 * auth-sensitive paths bypass the service worker cache in both the default
 * and /en-prefixed URL spaces, preventing stale session snapshots from flashing
 * after login/logout transitions.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// public/sw.js is plain JS served verbatim to the browser — it can't be
// imported (it touches `self`/`caches` at load). Slice out the pure matcher
// and its constants so the assertions run against the shipped source, not a
// hand-copied duplicate that would drift.
const source = readFileSync("public/sw.js", "utf8");

const privateMatch = source.match(/const PRIVATE_PATH_PREFIXES\s*=\s*\[[^\]]+\];/);
const localeMatch = source.match(/const LOCALE_PREFIXES\s*=\s*\[[^\]]+\];/);
const fnMatch = source.match(/function isPrivatePath\([^)]*\)\s*\{[\s\S]*?\n\}/);

if (!privateMatch || !localeMatch || !fnMatch) {
  throw new Error("Failed to extract isPrivatePath and its constants from public/sw.js");
}

const isPrivatePath = new Function(
  `${privateMatch[0]}\n${localeMatch[0]}\n${fnMatch[0]}\nreturn isPrivatePath;`,
)() as (pathname: string) => boolean;

describe("isPrivatePath (SW cache bypass)", () => {
  it("treats default-locale private paths as private", () => {
    for (const p of ["/me", "/me/", "/moderate", "/add", "/auth/google"]) {
      expect(isPrivatePath(p)).toBe(true);
    }
  });

  it("treats /en-prefixed private paths as private (regression)", () => {
    for (const p of ["/en/me", "/en/moderate", "/en/add", "/en/auth/google"]) {
      expect(isPrivatePath(p)).toBe(true);
    }
  });

  it("treats trailing slashes under locale prefixes as private", () => {
    expect(isPrivatePath("/en/me/")).toBe(true);
  });

  it("treats public routes as cacheable", () => {
    for (const p of ["/", "/about", "/en", "/en/about", "/stadt/frankfurt", "/k/tk_fr_0001"]) {
      expect(isPrivatePath(p)).toBe(false);
    }
  });

  it("does not match bare substrings on segment boundaries", () => {
    expect(isPrivatePath("/english")).toBe(false);
    expect(isPrivatePath("/mendoza")).toBe(false);
  });
});
