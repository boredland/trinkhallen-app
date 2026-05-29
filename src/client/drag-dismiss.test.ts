/**
 * Tests for the shared mobile drag-to-dismiss helper used by both the kiosk
 * sheet and the filter sidebar. Drives synthetic pointer events through a
 * forced-mobile matchMedia and asserts the threshold logic.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let installDragToDismiss: typeof import("./drag-dismiss").installDragToDismiss;

beforeAll(async () => {
  await GlobalRegistrator.register();
  ({ installDragToDismiss } = await import("./drag-dismiss"));
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function forceViewport(mobile: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    // installDragToDismiss checks `(min-width: 640px)` — desktop = matches.
    value: () => ({ matches: !mobile }) as MediaQueryList,
  });
}

function makeHandle(panelHeight: number): { handle: HTMLElement; target: HTMLElement } {
  document.body.innerHTML = `<div data-target><button data-handle></button></div>`;
  const target = document.querySelector<HTMLElement>("[data-target]")!;
  const handle = document.querySelector<HTMLElement>("[data-handle]")!;
  // happy-dom returns 0 for getBoundingClientRect height; stub a real value.
  target.getBoundingClientRect = () => ({ height: panelHeight }) as DOMRect;
  // setPointerCapture isn't implemented in happy-dom.
  handle.setPointerCapture = () => {};
  return { handle, target };
}

function pointer(type: string, clientY: number): PointerEvent {
  // happy-dom lacks a PointerEvent ctor with clientY; fake the shape.
  const ev = new Event(type, { bubbles: true }) as unknown as {
    clientY: number;
    pointerId: number;
  };
  ev.clientY = clientY;
  ev.pointerId = 1;
  return ev as unknown as PointerEvent;
}

beforeEach(() => {
  forceViewport(true);
});

describe("installDragToDismiss", () => {
  it("dismisses when the drag passes the threshold", () => {
    let dismissed = false;
    const { handle, target } = makeHandle(400);
    installDragToDismiss({
      handle,
      target,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    handle.dispatchEvent(pointer("pointerdown", 0));
    handle.dispatchEvent(pointer("pointermove", 150)); // 150 > 400*0.25 = 100
    handle.dispatchEvent(pointer("pointerup", 150));

    expect(dismissed).toBe(true);
    // Inline drag styles are cleared on release.
    expect(target.style.transform).toBe("");
  });

  it("springs back when the drag is below the threshold", () => {
    let dismissed = false;
    const { handle, target } = makeHandle(400);
    installDragToDismiss({
      handle,
      target,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    handle.dispatchEvent(pointer("pointerdown", 0));
    handle.dispatchEvent(pointer("pointermove", 40)); // 40 < 100
    handle.dispatchEvent(pointer("pointerup", 40));

    expect(dismissed).toBe(false);
  });

  it("is a no-op on desktop", () => {
    forceViewport(false);
    let dismissed = false;
    const { handle, target } = makeHandle(400);
    installDragToDismiss({
      handle,
      target,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    handle.dispatchEvent(pointer("pointerdown", 0));
    handle.dispatchEvent(pointer("pointermove", 300));
    handle.dispatchEvent(pointer("pointerup", 300));

    expect(dismissed).toBe(false);
  });

  it("cancel never dismisses, even past the threshold", () => {
    let dismissed = false;
    const { handle, target } = makeHandle(400);
    installDragToDismiss({
      handle,
      target,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    handle.dispatchEvent(pointer("pointerdown", 0));
    handle.dispatchEvent(pointer("pointermove", 300));
    handle.dispatchEvent(pointer("pointercancel", 300));

    expect(dismissed).toBe(false);
  });
});
