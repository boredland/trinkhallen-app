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

const ACTIVE_CLASS = "text-neon-amber";
const INACTIVE_CLASSES = ["text-fg-dim", "hover:text-neon-amber/60"];

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

function showError(form: HTMLFormElement, message: string | null): void {
  const el = form.querySelector<HTMLElement>("[data-rating-error]");
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

async function onSubmit(form: HTMLFormElement, submitter: HTMLButtonElement | null): Promise<void> {
  // Button-level formaction (Löschen) wins over the form's action. Read the
  // attribute, not the `.formAction` IDL property: the latter returns the
  // document URL (not "") when the attribute is absent, so "Abgeben" — which
  // has no formaction — would POST to the current /k/:id page and 404.
  const action = submitter?.getAttribute("formaction") || form.action;
  const isDelete = action.endsWith("/delete");

  // Star selection is validated here, not via `required` on the radios:
  // those are sr-only, so a native unfilled-required block fires no submit
  // event and the button just looks dead. Delete needs no star.
  if (!isDelete && !form.querySelector("input[name='stars']:checked")) {
    showError(form, "Bitte wähle 1–5 Sterne aus.");
    form.querySelector<HTMLElement>("[data-stars-group]")?.scrollIntoView({ block: "nearest" });
    return;
  }
  showError(form, null);

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
      showError(
        form,
        resp.status === 401
          ? "Bitte melde dich an, um zu bewerten."
          : "Konnte die Bewertung nicht speichern. Bitte später erneut versuchen.",
      );
      return;
    }
    const html = await resp.text();
    const host = document.getElementById("rating-block");
    if (host) host.outerHTML = html;
  } catch {
    buttons.forEach((b) => (b.disabled = false));
    showError(form, "Netzwerkfehler — bitte erneut versuchen.");
  }
}
