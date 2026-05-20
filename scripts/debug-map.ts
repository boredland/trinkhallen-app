/**
 * Opens a target URL with Playwright, lets MapLibre attempt to render,
 * then dumps:
 *   - console messages (with levels)
 *   - failed network requests
 *   - blocked-by-CSP requests
 *   - the map canvas's bounding rect + a few computed style props
 *   - a screenshot
 *
 * Usage: pnpm tsx scripts/debug-map.ts <url>
 */

import { chromium, type ConsoleMessage, type Request } from "playwright";
import { mkdir } from "node:fs/promises";

const url = process.argv[2] ?? "https://trinkhallen.app/";
const OUT = ".tmp/debug";

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const consoleMsgs: Array<{ type: string; text: string; location?: string }> = [];
const requestFailures: Array<{ url: string; failure: string }> = [];
const cspViolations: string[] = [];

page.on("console", (m: ConsoleMessage) => {
  consoleMsgs.push({
    type: m.type(),
    text: m.text(),
    location: m.location().url ? `${m.location().url}:${m.location().lineNumber}` : undefined,
  });
});
page.on("pageerror", (e) => {
  consoleMsgs.push({ type: "pageerror", text: `${e.name}: ${e.message}\n${e.stack ?? ""}` });
});
page.on("requestfailed", (r: Request) => {
  requestFailures.push({ url: r.url(), failure: r.failure()?.errorText ?? "unknown" });
});
page.on("response", async (resp) => {
  if (resp.status() >= 400) {
    consoleMsgs.push({
      type: "http",
      text: `${resp.status()} ${resp.url()}`,
    });
  }
});

console.log(`Loading ${url} …`);
await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch((e) => {
  console.log("goto error:", e.message);
});
// Give MapLibre a moment for the style + tile fetches even after networkidle.
await page.waitForTimeout(3000);

const mapInfo = await page.evaluate(() => {
  const el = document.getElementById("map");
  if (!el) return { mounted: false };
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const canvas = el.querySelector("canvas");
  const canvasRect = canvas?.getBoundingClientRect() ?? null;
  return {
    mounted: true,
    rect: { width: rect.width, height: rect.height, x: rect.x, y: rect.y },
    computed: {
      display: cs.display,
      position: cs.position,
      width: cs.width,
      height: cs.height,
      visibility: cs.visibility,
      opacity: cs.opacity,
    },
    canvasFound: !!canvas,
    canvasRect: canvasRect && { width: canvasRect.width, height: canvasRect.height },
    dataset: { ...(el as HTMLElement).dataset },
    childCount: el.childElementCount,
  };
});

console.log("\n--- map element ---");
console.log(JSON.stringify(mapInfo, null, 2));

console.log("\n--- console messages (last 30) ---");
for (const m of consoleMsgs.slice(-30)) {
  console.log(`[${m.type}] ${m.text}${m.location ? ` @ ${m.location}` : ""}`);
}

console.log("\n--- request failures ---");
for (const r of requestFailures) console.log(`${r.failure}: ${r.url}`);

await page.screenshot({ path: `${OUT}/screenshot.png`, fullPage: false });
console.log(`\nScreenshot → ${OUT}/screenshot.png`);

await browser.close();
