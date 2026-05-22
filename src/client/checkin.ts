/**
 * Check-in island.
 *
 * Wires the "Ich war hier" button rendered by CheckinForm.tsx:
 *   1. Best-effort browser geolocation (short timeout — no blocking UX).
 *   2. POST /api/checkins with kiosk_id + lat/lng if granted.
 *   3. Reveal the gap-fill questions by toggling data-open on the wrapper.
 *
 * Idempotent: re-running `install()` after the sheet swaps in new content
 * is safe — handlers are attached once per button via dataset markers.
 */

export function installCheckinForm(scope: ParentNode = document): void {
  const buttons = scope.querySelectorAll<HTMLButtonElement>("[data-checkin-button]");
  for (const btn of buttons) {
    if (btn.dataset["checkinWired"] === "1") continue;
    btn.dataset["checkinWired"] = "1";
    btn.addEventListener("click", onCheckinClick);
  }
  const forms = scope.querySelectorAll<HTMLFormElement>("[data-checkin-form]");
  for (const form of forms) {
    if (form.dataset["checkinFormWired"] === "1") continue;
    form.dataset["checkinFormWired"] = "1";
    form.addEventListener("submit", onFormSubmit);
  }
}

function onCheckinClick(ev: MouseEvent): void {
  const btn = ev.currentTarget as HTMLButtonElement;
  const wrapper = btn.closest<HTMLElement>("[data-checkin]");
  if (!wrapper) return;
  const kioskId = wrapper.dataset["kioskId"];
  if (!kioskId) return;

  // Visual: lock the button immediately so a panicked double-tap doesn't fire
  // two POSTs (the server dedupes per-day anyway, but no point being noisy).
  btn.disabled = true;
  btn.textContent = "Danke! Was hat gefehlt?";
  wrapper.dataset["open"] = "true";
  // Reveal the question block. Using the native `hidden` attribute keeps
  // the component pure JSX (no extra CSS selector gymnastics).
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

async function onFormSubmit(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const form = ev.currentTarget as HTMLFormElement;
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
    // Replace the form with the "Danke!" fragment from the server.
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
