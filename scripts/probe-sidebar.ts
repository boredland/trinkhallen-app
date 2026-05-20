import { chromium } from "playwright";

const url = process.argv[2] ?? "https://trinkhallen.app/";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
await page.waitForTimeout(2500);

const dump = await page.evaluate(`
  (() => {
    const describe = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        id: el.id || undefined,
        width: r.width, height: r.height,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        display: cs.display,
        flexDirection: cs.flexDirection,
        flex: cs.flex,
        minHeight: cs.minHeight,
        maxHeight: cs.maxHeight,
        position: cs.position,
        top: cs.top, bottom: cs.bottom,
        overflow: cs.overflowY + '/' + cs.overflowX,
      };
    };
    const aside = document.querySelector('[data-sidebar]');
    const panel = document.getElementById('kiosk-panel');
    return {
      main: describe(document.querySelector('main')),
      aside: describe(aside),
      filterDiv: describe(aside && aside.children[0]),
      addLink: describe(aside && aside.querySelector(':scope > a')),
      panel: describe(panel),
      listOuter: describe(panel && panel.firstElementChild),
      ul: describe(panel && panel.querySelector('ul')),
    };
  })()
`);
console.log(JSON.stringify(dump, null, 2));
await browser.close();
