/**
 * Rating island.
 *
 *   1. Stars: clicking a star repaints all spans in its group immediately so
 *      the user sees their selection before submitting. SSR already renders
 *      the right colors for an existing rating — this just keeps the visual
 *      state in sync with the hidden radio inputs as the user changes their
 *      mind.
 *   2. Form: intercept submit, POST with `X-Tk-Fragment: 1` so the server
 *      returns a `<RatingBlock>` fragment instead of redirecting, and swap
 *      `#rating-block` in place. Without JS the server's redirect path takes
 *      over — graceful fallback.
 *
 * Delegated at the document level so the wiring survives sheet swaps and the
 * "rating just got replaced by the server fragment" reflow.
 */

const ACTIVE_CLASS = "text-status-open";
const INACTIVE_CLASSES = ["text-fg-dim", "hover:text-status-open/60"];

let installed = false;

export function installRatingForm(): void {
  if (installed) return;
  installed = true;

  document.addEventListener("change", (ev) => {
    const input = (ev.target as HTMLElement | null)?.closest<HTMLInputElement>(
      "[data-stars-group] input[name='stars']",
    );
    if (!input) return;
    paintStars(input);
  });

  document.addEventListener("submit", (ev) => {
    const form = (ev.target as HTMLElement | null)?.closest<HTMLFormElement>("[data-rating-form]");
    if (!form) return;
    ev.preventDefault();
    const submitEv = ev as SubmitEvent;
    const submitter = submitEv.submitter as HTMLButtonElement | null;
    void onSubmit(form, submitter);
  });
}

function paintStars(input: HTMLInputElement): void {
  const group = input.closest<HTMLElement>("[data-stars-group]");
  if (!group) return;
  const value = parseInt(input.value, 10);
  if (!Number.isFinite(value)) return;
  group.querySelectorAll<HTMLElement>("[data-star-value]").forEach((span) => {
    const sv = parseInt(span.dataset["starValue"] ?? "0", 10);
    const active = sv <= value;
    span.classList.toggle(ACTIVE_CLASS, active);
    for (const cls of INACTIVE_CLASSES) span.classList.toggle(cls, !active);
  });
}

async function onSubmit(form: HTMLFormElement, submitter: HTMLButtonElement | null): Promise<void> {
  // Button-level formaction (Löschen) wins over the form's action.
  const action = submitter?.formAction || form.action;
  const buttons = form.querySelectorAll<HTMLButtonElement>("button[type='submit']");
  buttons.forEach((b) => (b.disabled = true));
  try {
    const resp = await fetch(action, {
      method: "POST",
      headers: { "X-Tk-Fragment": "1" },
      body: new FormData(form),
    });
    if (!resp.ok) {
      buttons.forEach((b) => (b.disabled = false));
      return;
    }
    const html = await resp.text();
    const host = document.getElementById("rating-block");
    if (host) host.outerHTML = html;
  } catch {
    buttons.forEach((b) => (b.disabled = false));
  }
}
