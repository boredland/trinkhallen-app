/**
 * Smoke test: load the map in a real browser, verify the static data path
 * is exercised end-to-end, screenshot for visual confirm.
 *
 * Run while `pnpm preview` is up:
 *   tsx scripts/verify-static-map.ts
 */

import { chromium } from "playwright";

const BASE = process.env["BASE_URL"] ?? "http://localhost:8787";
const SCREENSHOT_DIR = ".tmp/screenshots";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const requests: { url: string; status?: number }[] = [];
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/data/") || u.pathname.startsWith("/api/kiosks")) {
      requests.push({ url: u.pathname + u.search, status: r.status() });
    }
  });

  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(`[console] ${msg.text()}`); });

  console.log(`\nLoading ${BASE}/ (Frankfurt default centre)…`);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await new Promise((r) => setTimeout(r, 1500));

  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-default.png`, fullPage: false });

  console.log(`\nZooming out to z6 to trigger the summary view (?c=51.0,10.0&z=6)…`);
  await page.goto(`${BASE}/?c=51.0,10.0&z=6`, { waitUntil: "networkidle" });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-summary.png`, fullPage: false });

  console.log(`\nRequests to /data/* and /api/kiosks*:`);
  for (const r of requests) console.log(`  ${r.status} ${r.url}`);
  if (errors.length > 0) {
    console.log(`\nPage errors:`);
    for (const e of errors) console.log(`  ${e}`);
  } else {
    console.log(`\nNo page errors.`);
  }

  await browser.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
