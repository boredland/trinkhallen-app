/**
 * Ensures .env.example stays in sync with the authoritative Env interface in src/env.d.ts.
 *
 * .env.example is the onboarding contract for new contributors (copied to .dev.vars).
 * If a secret or variable is missing from .env.example (such as TURNSTILE_SECRET_KEY),
 * local dev may silently disable security controls or fail at runtime without any signal.
 * Likewise, dead variables (such as leftover webhook secrets) should not linger in .env.example.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Cloudflare Worker bindings (DB, ASSETS, EMAIL) are wired by wrangler.toml,
// not passed via .dev.vars / .env.example.
const BINDINGS = new Set(["DB", "ASSETS", "EMAIL"]);

function parseEnvInterface(dtsPath: string): Set<string> {
  const content = readFileSync(dtsPath, "utf-8");
  const match = content.match(/export interface Env\s*\{([\s\S]*?)\n\}/);
  if (!match?.[1]) {
    throw new Error(`Could not find 'export interface Env' in ${dtsPath}`);
  }
  const members = new Set<string>();
  for (const line of match[1].split("\n")) {
    const propMatch = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*:/);
    if (propMatch?.[1]) {
      members.add(propMatch[1]);
    }
  }
  return members;
}

function parseEnvExample(examplePath: string): Set<string> {
  const content = readFileSync(examplePath, "utf-8");
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const keyMatch = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (keyMatch?.[1]) {
      keys.add(keyMatch[1]);
    }
  }
  return keys;
}

describe(".env.example drift check", () => {
  const dtsPath = resolve(__dirname, "env.d.ts");
  const examplePath = resolve(__dirname, "../.env.example");

  const envMembers = parseEnvInterface(dtsPath);
  const exampleKeys = parseEnvExample(examplePath);

  it("includes all non-binding Env members in .env.example", () => {
    const expectedKeys = [...envMembers].filter((name) => !BINDINGS.has(name));
    const missingFromExample = expectedKeys.filter((key) => !exampleKeys.has(key));

    expect(missingFromExample).toEqual([]);
  });

  it("does not contain extraneous or dead keys not defined in Env", () => {
    const unexpectedKeys = [...exampleKeys].filter((key) => !envMembers.has(key));

    expect(unexpectedKeys).toEqual([]);
  });
});
