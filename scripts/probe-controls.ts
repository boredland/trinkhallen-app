import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const url = process.argv[2] ?? "https://trinkhallen.app/";
await mkdir(".tmp/debug", { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
  const out: Record<string, unknown> = {};
  for (const c of corners) {
    const el = document.querySelector(`.maplibregl-ctrl-${c}`);
    if (!el) { out[c] = "missing"; continue; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out[c] = {
      rect: r.toJSON(),
      position: cs.position,
      top: cs.top, right: cs.right, bottom: cs.bottom, left: cs.left,
      zIndex: cs.zIndex,
      children: el.childElementCount,
    };
  }
  // Also check the canvas-container size for reference
  const cc = document.querySelector(".maplibregl-canvas-container");
  return {
    corners: out,
    canvasContainer: cc ? { rect: cc.getBoundingClientRect().toJSON(), position: getComputedStyle(cc).position } : null,
    maplibreCssLoaded: !!Array.from(document.styleSheets).find((s) => {
      try { return Array.from(s.cssRules).some((r) => r.cssText.includes(".maplibregl-ctrl-top-right")); } catch { return false; }
    }),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
