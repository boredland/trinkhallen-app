/**
 * Behavioural test for the "App aktualisieren" button. Confirms a click tears
 * down Cache Storage + service-worker registrations and triggers a reload —
 * the manual escape hatch for a stale cached bundle.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let installRefreshButton: typeof import("./refresh").installRefreshButton;

beforeAll(async () => {
  await GlobalRegistrator.register();
  ({ installRefreshButton } = await import("./refresh"));
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const deletedCaches: string[] = [];
let unregisterCalls = 0;
let replacedUrl = "";

beforeEach(() => {
  deletedCaches.length = 0;
  unregisterCalls = 0;
  replacedUrl = "";

  (globalThis as unknown as { caches: unknown }).caches = {
    keys: () => Promise.resolve(["tk-static-v7", "tk-runtime-v7"]),
    delete: (k: string) => {
      deletedCaches.push(k);
      return Promise.resolve(true);
    },
  };

  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistrations: () =>
        Promise.resolve([
          {
            unregister: () => {
              unregisterCalls += 1;
              return Promise.resolve(true);
            },
          },
        ]),
    },
  });

  // happy-dom's location.replace is a no-op stub that can throw on navigation;
  // override with a spy so we can assert the cache-busting URL.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: "https://trinkhallen.app/k/tk_fr_001",
      replace: (url: string) => {
        replacedUrl = url;
      },
    },
  });

  document.body.innerHTML = `<button type="button" data-tk-refresh>App aktualisieren</button>`;
  installRefreshButton();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("installRefreshButton", () => {
  it("clears caches, unregisters the SW, and reloads with a cache-buster", async () => {
    document.querySelector<HTMLButtonElement>("[data-tk-refresh]")!.click();
    await settle();

    expect(deletedCaches).toEqual(["tk-static-v7", "tk-runtime-v7"]);
    expect(unregisterCalls).toBe(1);
    expect(replacedUrl).toContain("_r=");
    expect(replacedUrl).toContain("/k/tk_fr_001");
  });
});
