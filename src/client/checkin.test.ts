/**
 * Behavioural tests for the check-in signal handler.
 *
 * These run against the *real* `src/client/checkin.ts` module inside a
 * happy-dom-emulated browser. Every test simulates a click on a server-rendered
 * confirm/dispute button and asserts that the resulting DOM matches what the
 * user actually sees — green success, amber low-confidence, red error.
 *
 * Why this layer: the recent "I press the button and nothing happens" bug was
 * a silent-fail in a handler branch. A unit test of `recordSignal` couldn't
 * catch it (the server logic was fine); a Playwright run against a real server
 * would, but with auth + dev-server orchestration costs out of scope here.
 * Driving the handler in a DOM is the cheapest correct catch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let installCheckinForm: typeof import("./checkin").installCheckinForm;
let fetchMock: ReturnType<typeof mock>;

beforeAll(async () => {
  await GlobalRegistrator.register();
  // Import AFTER globals are set up so the module sees happy-dom's document
  // when it later attaches the click listener.
  ({ installCheckinForm } = await import("./checkin"));
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  // Default fetch mock: verified=true. Individual tests can override.
  fetchMock = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ verified: true, reason: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  document.body.innerHTML = "";
});

function renderCheckinDom(coords: { lat?: string; lng?: string; accuracy?: string } = {}): void {
  const attrs = [`data-kiosk-id="tk_test_001"`];
  if (coords.lat !== undefined) attrs.push(`data-lat="${coords.lat}"`);
  if (coords.lng !== undefined) attrs.push(`data-lng="${coords.lng}"`);
  if (coords.accuracy !== undefined) attrs.push(`data-accuracy="${coords.accuracy}"`);
  document.body.innerHTML = `
    <div data-checkin ${attrs.join(" ")}>
      <div data-confirm-block class="block">
        <p>Stimmt's noch?</p>
        <button type="button" data-signal-confirm data-field-key="opening_hours">Passt</button>
        <button type="button" data-signal-dispute data-field-key="opening_hours">Stimmt nicht</button>
      </div>
    </div>
  `;
  // The install function is idempotent (installed-once flag); we still call it
  // every test so a future regression that breaks the attach is caught here.
  installCheckinForm();
}

/** Let the handler's awaited fetch + json + DOM swap settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

function clickButton(selector: string): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(selector);
  if (!btn) throw new Error(`button ${selector} not in DOM`);
  btn.click();
  return btn;
}

describe("signal click handler", () => {
  it("POSTs to /api/signals with the cached coords + action=confirm", async () => {
    renderCheckinDom({ lat: "50.1", lng: "8.7", accuracy: "10" });
    clickButton("[data-signal-confirm]");
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/signals");
    expect(init?.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("kiosk_id")).toBe("tk_test_001");
    expect(body.get("field_key")).toBe("opening_hours");
    expect(body.get("action")).toBe("confirm");
    expect(body.get("lat")).toBe("50.1");
    expect(body.get("lng")).toBe("8.7");
    expect(body.get("accuracy")).toBe("10");
  });

  it("uses action=dispute when the 'Stimmt nicht' button is clicked", async () => {
    renderCheckinDom({ lat: "50.1", lng: "8.7", accuracy: "10" });
    clickButton("[data-signal-dispute]");
    await settle();
    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.get("action")).toBe("dispute");
  });

  it("shows the green success treatment when the server reports verified=true", async () => {
    renderCheckinDom({ lat: "50.1", lng: "8.7", accuracy: "10" });
    clickButton("[data-signal-confirm]");
    await settle();
    expect(document.body.innerHTML).toContain("Bestätigt — danke!");
    expect(document.body.innerHTML).toContain("text-success");
    expect(document.body.innerHTML).not.toContain("data-confirm-block");
  });

  it("shows the amber low-confidence treatment when the server reports verified=false", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ verified: false, reason: "out_of_range" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;
    renderCheckinDom({ lat: "50.1", lng: "8.7", accuracy: "10" });
    clickButton("[data-signal-confirm]");
    await settle();
    expect(document.body.innerHTML).toContain("ohne Vor-Ort-Prüfung");
    expect(document.body.innerHTML).toContain("text-neon-amber");
  });

  it("surfaces a server error visibly instead of failing silently", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("oops", { status: 500 })),
    ) as unknown as typeof fetch;
    renderCheckinDom({ lat: "50.1", lng: "8.7", accuracy: "10" });
    clickButton("[data-signal-confirm]");
    await settle();
    expect(document.body.innerHTML).toContain("Server-Fehler (500)");
    expect(document.body.innerHTML).toContain("text-danger");
  });

  it("surfaces a network error visibly instead of failing silently", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    renderCheckinDom({ lat: "50.1", lng: "8.7", accuracy: "10" });
    clickButton("[data-signal-confirm]");
    await settle();
    expect(document.body.innerHTML).toContain("Netzwerkfehler");
    expect(document.body.innerHTML).toContain("text-danger");
  });

  it("guards against double-clicks — only one POST", async () => {
    renderCheckinDom({ lat: "50.1", lng: "8.7", accuracy: "10" });
    const btn = clickButton("[data-signal-confirm]");
    btn.click();
    btn.click();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disables the sibling action while the request is in flight", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    renderCheckinDom({ lat: "50.1", lng: "8.7", accuracy: "10" });
    clickButton("[data-signal-confirm]");
    await new Promise((r) => setTimeout(r, 0));
    const sibling = document.querySelector<HTMLButtonElement>("[data-signal-dispute]");
    expect(sibling?.disabled).toBe(true);
    resolveFetch?.(
      new Response(JSON.stringify({ verified: true, reason: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await settle();
  });

  it("shows 'Interner Fehler' when the wrapper / kioskId is missing", async () => {
    // No data-kiosk-id on the wrapper — exercises the defensive guard.
    document.body.innerHTML = `
      <div data-checkin>
        <div data-confirm-block>
          <button type="button" data-signal-confirm data-field-key="opening_hours">Passt</button>
        </div>
      </div>
    `;
    installCheckinForm();
    clickButton("[data-signal-confirm]");
    await settle();
    expect(document.body.innerHTML).toContain("Interner Fehler");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
