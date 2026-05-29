/**
 * Mobile drag-to-dismiss for bottom-anchored panels.
 *
 * Shared by the kiosk sheet (drag down to close) and the filter sidebar (drag
 * down to collapse). Pointer drag on `surface` translates `target` downward;
 * releasing past `threshold` × the measured height fires `onDismiss`, otherwise
 * the panel springs back. Desktop (≥640px) is a no-op — these panels dock to an
 * edge there.
 *
 * `surface` can be a small grab handle OR the whole scrollable panel. In the
 * latter case pass `scrollContainer`: a drag then only begins when that
 * container is scrolled to the top and the finger moves *down*, so normal
 * content scrolling is untouched (at scrollTop 0 a downward pull produces no
 * native scroll, so the transform wins without fighting `touch-action`).
 */

export interface DragToDismissOptions {
  /** Element the pointer drag is bound to — a handle, or the whole panel. */
  surface: HTMLElement;
  /** Element that receives the translateY transform during the drag. */
  target: HTMLElement;
  /** Element whose height sets the dismiss distance. Defaults to `target`. */
  measure?: HTMLElement;
  /** Fraction of the measured height past which release dismisses. */
  threshold?: number;
  /**
   * When the surface is a scrollable panel, the drag only arms while this
   * container is at the top. Omit for a non-scrolling handle.
   */
  scrollContainer?: HTMLElement;
  /** Invoked when a release crosses the threshold. */
  onDismiss: () => void;
}

/** Pixels of downward movement before a press is treated as a drag (vs a tap). */
const MIN_DRAG_PX = 6;

export function installDragToDismiss(opts: DragToDismissOptions): void {
  const { surface, target, measure = target, threshold = 0.3, scrollContainer, onDismiss } = opts;

  let startY = 0;
  let lastDy = 0;
  let armed = false; // press is down and a drag is still possible
  let dragging = false; // drag committed — we're translating
  let moved = false;

  const onPointerDown = (e: PointerEvent) => {
    if (window.matchMedia("(min-width: 640px)").matches) return; // mobile only
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A scrollable surface only arms when already at the top; otherwise the
    // gesture is a normal scroll and we stay out of its way.
    if (scrollContainer && scrollContainer.scrollTop > 0) return;
    startY = e.clientY;
    lastDy = 0;
    armed = true;
    dragging = false;
    moved = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!armed && !dragging) return;
    const dy = e.clientY - startY;

    if (!dragging) {
      // Upward (scroll-into-content) or the container scrolled off the top →
      // hand the gesture back to the browser.
      if (dy < -MIN_DRAG_PX || (scrollContainer && scrollContainer.scrollTop > 0)) {
        armed = false;
        return;
      }
      if (dy < MIN_DRAG_PX) return; // within slop — still possibly a tap
      dragging = true;
      surface.setPointerCapture(e.pointerId);
      target.style.transition = "none";
    }

    lastDy = Math.max(0, dy);
    moved = true;
    target.style.transform = `translateY(${lastDy}px)`;
    e.preventDefault();
  };

  const endDrag = (cancelled: boolean) => {
    const wasDragging = dragging;
    armed = false;
    dragging = false;
    if (!wasDragging) return;

    target.style.transition = "";
    target.style.transform = "";
    const height = measure.getBoundingClientRect().height || 600;
    if (!cancelled && lastDy > height * threshold) onDismiss();

    // Swallow the click that would otherwise fire on whatever the drag started
    // over (e.g. a kiosk link), so a dismiss-drag never also navigates.
    if (moved) {
      const swallow = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      surface.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => surface.removeEventListener("click", swallow, { capture: true }), 0);
    }
  };

  surface.addEventListener("pointerdown", onPointerDown);
  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerup", () => endDrag(false));
  surface.addEventListener("pointercancel", () => endDrag(true));
}
