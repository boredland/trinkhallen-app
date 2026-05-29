/**
 * Tests for the shared mobile drag-to-dismiss helper used by both the kiosk
 * sheet and the filter sidebar. Drives synthetic pointer events through a
 * forced-mobile matchMedia and asserts the threshold + scroll-gate logic.
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
    // the helper checks `(min-width: 640px)` — desktop = matches.
    value: () => ({ matches: !mobile }) as MediaQueryList,
  });
}

function makeSurface(panelHeight: number): HTMLElement {
  document.body.innerHTML = `<div data-surface></div>`;
  const surface = document.querySelector<HTMLElement>("[data-surface]")!;
  surface.getBoundingClientRect = () => ({ height: panelHeight }) as DOMRect;
  surface.setPointerCapture = () => {};
  // happy-dom's scrollTop is settable; default 0.
  return surface;
}

function pointer(type: string, clientY: number): PointerEvent {
  const ev = new Event(type, { bubbles: true }) as unknown as {
    clientY: number;
    pointerId: number;
    pointerType: string;
    button: number;
  };
  ev.clientY = clientY;
  ev.pointerId = 1;
  ev.pointerType = "touch";
  ev.button = 0;
  return ev as unknown as PointerEvent;
}

function drag(surface: HTMLElement, ...ys: number[]): void {
  surface.dispatchEvent(pointer("pointerdown", ys[0]!));
  for (const y of ys.slice(1)) surface.dispatchEvent(pointer("pointermove", y));
  surface.dispatchEvent(pointer("pointerup", ys[ys.length - 1]!));
}

beforeEach(() => {
  forceViewport(true);
});

describe("installDragToDismiss", () => {
  it("dismisses when the drag passes the threshold", () => {
    let dismissed = false;
    const surface = makeSurface(400);
    installDragToDismiss({
      surface,
      target: surface,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    drag(surface, 0, 150); // 150 > 400*0.25 = 100
    expect(dismissed).toBe(true);
    expect(surface.style.transform).toBe(""); // cleared on release
  });

  it("springs back when the drag is below the threshold", () => {
    let dismissed = false;
    const surface = makeSurface(400);
    installDragToDismiss({
      surface,
      target: surface,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    drag(surface, 0, 40); // 40 < 100
    expect(dismissed).toBe(false);
  });

  it("is a no-op on desktop", () => {
    forceViewport(false);
    let dismissed = false;
    const surface = makeSurface(400);
    installDragToDismiss({
      surface,
      target: surface,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    drag(surface, 0, 300);
    expect(dismissed).toBe(false);
  });

  it("cancel never dismisses, even past the threshold", () => {
    let dismissed = false;
    const surface = makeSurface(400);
    installDragToDismiss({
      surface,
      target: surface,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    surface.dispatchEvent(pointer("pointerdown", 0));
    surface.dispatchEvent(pointer("pointermove", 300));
    surface.dispatchEvent(pointer("pointercancel", 300));
    expect(dismissed).toBe(false);
  });

  it("does not arm when the scroll container is not at the top", () => {
    let dismissed = false;
    const surface = makeSurface(400);
    surface.scrollTop = 120; // scrolled into the list → gesture is a scroll
    installDragToDismiss({
      surface,
      target: surface,
      scrollContainer: surface,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    drag(surface, 0, 300);
    expect(dismissed).toBe(false);
  });

  it("dismisses from the top of a scrollable surface", () => {
    let dismissed = false;
    const surface = makeSurface(400);
    surface.scrollTop = 0;
    installDragToDismiss({
      surface,
      target: surface,
      scrollContainer: surface,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    drag(surface, 0, 150);
    expect(dismissed).toBe(true);
  });

  it("disarms on an upward (scroll-into-content) move", () => {
    let dismissed = false;
    const surface = makeSurface(400);
    installDragToDismiss({
      surface,
      target: surface,
      scrollContainer: surface,
      threshold: 0.25,
      onDismiss: () => {
        dismissed = true;
      },
    });

    // Up first (hands off to the browser), then a big down move must not dismiss.
    drag(surface, 100, 70, 400);
    expect(dismissed).toBe(false);
  });
});
