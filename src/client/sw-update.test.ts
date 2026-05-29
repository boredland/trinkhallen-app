/**
 * Behavioural test for the SW update prompt. Confirms a waiting worker surfaces
 * a reload toast, that accepting it posts SKIP_WAITING to the worker, and that
 * a subsequent controllerchange reloads the page. This is the durable fix for
 * the stale-bundle class of bug, so it's worth pinning down.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let installServiceWorker: typeof import("./sw-update").installServiceWorker;

beforeAll(async () => {
  await GlobalRegistrator.register();
  ({ installServiceWorker } = await import("./sw-update"));
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

interface FakeWorker {
  postMessage: (msg: unknown) => void;
  posted: unknown[];
}

function makeWorker(): FakeWorker {
  const posted: unknown[] = [];
  return { posted, postMessage: (m) => posted.push(m) };
}

type Listener = () => void;

interface Harness {
  controllerChange: Listener[];
  registerWith: (reg: unknown) => void;
  reloads: number;
  fireLoad: () => Promise<void>;
  fireControllerChange: () => void;
}

function installSwMock(opts: { controller: object | null }): Harness {
  const controllerChange: Listener[] = [];
  let registered: unknown;
  const loadListeners: Listener[] = [];
  const h: Harness = {
    controllerChange,
    registerWith: (reg) => {
      registered = reg;
    },
    reloads: 0,
    fireLoad: async () => {
      for (const l of loadListeners) l();
      await new Promise((r) => setTimeout(r, 0));
    },
    fireControllerChange: () => {
      for (const l of controllerChange) l();
    },
  };

  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller: opts.controller,
      register: () => Promise.resolve(registered),
      addEventListener: (type: string, cb: Listener) => {
        if (type === "controllerchange") controllerChange.push(cb);
      },
    },
  });

  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      protocol: "https:",
      reload: () => {
        h.reloads += 1;
      },
    },
  });

  // window.addEventListener('load', …) capture
  const origAdd = window.addEventListener.bind(window);
  // biome-ignore lint/suspicious/noExplicitAny: test shim over the DOM signature
  (window as any).addEventListener = (type: string, cb: Listener, ...rest: unknown[]) => {
    if (type === "load") loadListeners.push(cb);
    // biome-ignore lint/suspicious/noExplicitAny: forwarding
    else origAdd(type as any, cb as any, ...(rest as []));
  };

  return h;
}

function makeRegistration(waiting: FakeWorker | null) {
  const updateFound: Listener[] = [];
  return {
    waiting,
    active: null,
    installing: null,
    update: () => Promise.resolve(),
    addEventListener: (type: string, cb: Listener) => {
      if (type === "updatefound") updateFound.push(cb);
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  // Reset the module-level toastShown latch by re-importing fresh per test is
  // overkill; instead each test asserts on a clean body and the latch only
  // blocks duplicates, which we don't exercise across tests here.
});

describe("installServiceWorker update flow", () => {
  it("shows a reload toast when a worker is already waiting", async () => {
    const h = installSwMock({ controller: {} });
    const waiting = makeWorker();
    h.registerWith(makeRegistration(waiting));

    installServiceWorker();
    await h.fireLoad();

    const toast = document.querySelector('[role="status"]');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain("Neue Version");
  });

  it("posts SKIP_WAITING and reloads on controllerchange when accepted", async () => {
    const h = installSwMock({ controller: {} });
    const waiting = makeWorker();
    h.registerWith(makeRegistration(waiting));

    installServiceWorker();
    await h.fireLoad();

    const reloadBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Neu laden",
    );
    expect(reloadBtn).toBeTruthy();
    reloadBtn!.click();

    expect(waiting.posted).toEqual([{ type: "SKIP_WAITING" }]);

    // The browser fires controllerchange once the new worker activates.
    h.fireControllerChange();
    expect(h.reloads).toBe(1);
  });
});
