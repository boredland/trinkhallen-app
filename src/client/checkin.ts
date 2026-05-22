/**
 * Check-in island.
 *
 * Two responsibilities:
 *   1. The "Ich war hier" button — best-effort browser geolocation, POSTs
 *      /api/checkins, reveals the gap-fill question block.
 *   2. The gap-fill forms — intercept submit, POST to /api/reports, swap the
 *      "Danke!" fragment in place.
 *
 * Implementation: document-level event delegation so wiring is idempotent
 * and survives any number of sheet swaps without us re-running attach logic.
 * The legacy `installCheckinForm()` export remains so existing call sites
 * (app.entry.ts initial load + tk:sheet-body-swapped) keep working — it's
 * now a no-op after the first call.
 */

let installed = false;

export function installCheckinForm(_scope: ParentNode = document): void {
  if (installed) return;
  installed = true;

  document.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      "[data-checkin-button]",
    );
    if (!btn) return;
    onCheckinClick(btn);
  });

  document.addEventListener("submit", (ev) => {
    const form = (ev.target as HTMLElement | null)?.closest<HTMLFormElement>("[data-checkin-form]");
    if (!form) return;
    ev.preventDefault();
    void onFormSubmit(form);
  });
}

function onCheckinClick(btn: HTMLButtonElement): void {
  if (btn.dataset["checkinDone"] === "1") return;
  btn.dataset["checkinDone"] = "1";

  const wrapper = btn.closest<HTMLElement>("[data-checkin]");
  if (!wrapper) return;
  const kioskId = wrapper.dataset["kioskId"];
  if (!kioskId) return;

  btn.disabled = true;
  btn.textContent = "Danke! Was hat gefehlt?";
  wrapper.dataset["open"] = "true";
  const questions = wrapper.querySelector<HTMLElement>("[data-checkin-questions]");
  if (questions) questions.hidden = false;

  void postCheckin(kioskId);
}

async function postCheckin(kioskId: string): Promise<void> {
  const coords = await tryGeolocate();
  const body = new FormData();
  body.append("kiosk_id", kioskId);
  if (coords) {
    body.append("lat", String(coords.lat));
    body.append("lng", String(coords.lng));
  }
  try {
    await fetch("/api/checkins", { method: "POST", body });
  } catch {
    // Silent — the check-in is best-effort. The user already sees the form
    // questions; treating a network blip as a hard error would just nag them.
  }
}

async function onFormSubmit(form: HTMLFormElement): Promise<void> {
  const submitBtn = form.querySelector<HTMLButtonElement>("button[type='submit']");
  if (submitBtn) submitBtn.disabled = true;
  try {
    const resp = await fetch(form.action, {
      method: "POST",
      headers: { "X-Tk-Fragment": "1" },
      body: new FormData(form),
    });
    if (!resp.ok) {
      // Light-touch failure UX: re-enable the submit so the user can retry.
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
    const html = await resp.text();
    form.outerHTML = html;
  } catch {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function tryGeolocate(): Promise<{ lat: number; lng: number } | null> {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: { lat: number; lng: number } | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // Short timeout: we don't want to keep the user staring at a button.
    // If geolocation hasn't returned by then, treat it as "no location given".
    setTimeout(() => settle(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (pos) => settle({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => settle(null),
      { enableHighAccuracy: true, timeout: 3500, maximumAge: 60_000 },
    );
  });
}
