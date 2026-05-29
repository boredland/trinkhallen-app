import type { FC } from "hono/jsx";

/**
 * The mobile grab bar shared by the kiosk sheet and the filter sidebar. Marked
 * `data-drag-handle` so src/client/drag-dismiss.ts can wire the same drag
 * gesture to either. Hidden on desktop, where both panels dock to an edge and
 * use a button instead.
 */
export const DragHandle: FC<{ label: string }> = ({ label }) => (
  <button
    type="button"
    data-drag-handle
    aria-label={label}
    class="flex w-full cursor-grab touch-none items-center justify-center bg-surface py-2 sm:hidden"
  >
    <span class="block h-1 w-10 rounded-full bg-border-hi" />
  </button>
);
