/**
 * Mobile drag-to-dismiss for bottom-anchored panels.
 *
 * Shared by the kiosk sheet (drag down to close) and the filter sidebar (drag
 * down to collapse). Pointer drag on `handle` translates `target` downward;
 * releasing past `threshold` × the measured height fires `onDismiss`, otherwise
 * the panel springs back. Desktop (≥640px) is a no-op — these panels dock to an
 * edge there and have no handle.
 */

export interface DragToDismissOptions {
  /** The grab handle the user drags. */
  handle: HTMLElement;
  /** Element that receives the translateY transform during the drag. */
  target: HTMLElement;
  /** Element whose height sets the dismiss distance. Defaults to `target`. */
  measure?: HTMLElement;
  /** Fraction of the measured height past which release dismisses. */
  threshold?: number;
  /** Invoked when a release crosses the threshold. */
  onDismiss: () => void;
}

export function installDragToDismiss(opts: DragToDismissOptions): void {
  const { handle, target, measure = target, threshold = 0.3, onDismiss } = opts;

  let startY = 0;
  let lastDy = 0;
  let dragging = false;

  const onPointerDown = (e: PointerEvent) => {
    if (window.matchMedia("(min-width: 640px)").matches) return; // mobile only
    dragging = true;
    startY = e.clientY;
    lastDy = 0;
    handle.setPointerCapture(e.pointerId);
    target.style.transition = "none";
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    lastDy = Math.max(0, e.clientY - startY);
    target.style.transform = `translateY(${lastDy}px)`;
  };
  const endDrag = (cancelled: boolean) => {
    if (!dragging) return;
    dragging = false;
    target.style.transition = "";
    target.style.transform = "";
    const height = measure.getBoundingClientRect().height || 600;
    if (!cancelled && lastDy > height * threshold) onDismiss();
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", () => endDrag(false));
  handle.addEventListener("pointercancel", () => endDrag(true));
}
