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
    const target = ev.target as HTMLElement | null;
    const checkinBtn = target?.closest<HTMLButtonElement>("[data-checkin-button]");
    if (checkinBtn) {
      void onCheckinClick(checkinBtn);
      return;
    }
    const signalBtn = target?.closest<HTMLButtonElement>(
      "[data-signal-confirm], [data-signal-dispute]",
    );
    if (signalBtn) {
      ev.preventDefault();
      const action = signalBtn.hasAttribute("data-signal-dispute") ? "dispute" : "confirm";
      void onSignalSubmit(signalBtn, action);
    }
  });

  document.addEventListener("submit", (ev) => {
    const form = (ev.target as HTMLElement | null)?.closest<HTMLFormElement>("[data-checkin-form]");
    if (!form) return;
    ev.preventDefault();
    void onFormSubmit(form);
  });

  // Marker for the e2e smoke test: confirms the bundle loaded AND the install
  // function actually ran (i.e. no JS error, no CSP block, no SW serving an
  // ancient bundle that's missing this code). Cheap to set, easy to assert.
  (globalThis as unknown as { __tkCheckinInstalled?: boolean }).__tkCheckinInstalled = true;
}

async function onCheckinClick(btn: HTMLButtonElement): Promise<void> {
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

  // Geolocate once and cache on the wrapper so the follow-up signal POST can
  // reuse the same fix without a second permission/timeout round.
  const coords = await tryGeolocate();
  if (coords) {
    wrapper.dataset["lat"] = String(coords.lat);
    wrapper.dataset["lng"] = String(coords.lng);
    if (typeof coords.accuracy === "number" && Number.isFinite(coords.accuracy)) {
      wrapper.dataset["accuracy"] = String(coords.accuracy);
    }
  }
  void postCheckin(kioskId, coords);
}

async function postCheckin(kioskId: string, coords: Coords | null): Promise<void> {
  const body = new FormData();
  body.append("kiosk_id", kioskId);
  if (coords) {
    body.append("lat", String(coords.lat));
    body.append("lng", String(coords.lng));
    if (typeof coords.accuracy === "number" && Number.isFinite(coords.accuracy)) {
      body.append("accuracy", String(coords.accuracy));
    }
  }
  try {
    await fetch("/api/checkins", { method: "POST", body });
  } catch {
    // Silent — the check-in is best-effort. The user already sees the form
    // questions; treating a network blip as a hard error would just nag them.
  }
}

async function onSignalSubmit(
  btn: HTMLButtonElement,
  action: "confirm" | "dispute",
): Promise<void> {
  if (btn.dataset["signalDone"] === "1") return;
  btn.dataset["signalDone"] = "1";

  const wrapper = btn.closest<HTMLElement>("[data-checkin]");
  const block = btn.closest<HTMLElement>("[data-confirm-block]");
  const kioskId = wrapper?.dataset["kioskId"];
  const fieldKey = btn.dataset["fieldKey"];
  if (!wrapper || !kioskId || !fieldKey) {
    showSignalError(block, btn, "Interner Fehler — kann nicht senden.");
    return;
  }

  btn.disabled = true;
  // Also disable the sibling action so a quick confirm-then-dispute doesn't
  // race against itself.
  for (const sibling of block?.querySelectorAll<HTMLButtonElement>("button") ?? []) {
    sibling.disabled = true;
  }

  const body = new FormData();
  body.append("kiosk_id", kioskId);
  body.append("field_key", fieldKey);
  body.append("action", action);
  const lat = wrapper.dataset["lat"];
  const lng = wrapper.dataset["lng"];
  const accuracy = wrapper.dataset["accuracy"];
  if (lat) body.append("lat", lat);
  if (lng) body.append("lng", lng);
  if (accuracy) body.append("accuracy", accuracy);

  try {
    const resp = await fetch("/api/signals", { method: "POST", body });
    if (resp.ok) {
      // Always-record: server returns { verified, reason }. Verified rows get
      // the loud green confirmation; unverified ones land softer + amber so
      // the user knows it counted but with lower weight (engine sees verified=0).
      const data = (await resp.json().catch(() => ({ verified: true }))) as { verified?: boolean };
      showSignalSuccess(block, action, data.verified !== false);
      return;
    }
    showSignalError(block, btn, `Server-Fehler (${resp.status}). Bitte erneut versuchen.`);
  } catch {
    showSignalError(block, btn, "Netzwerkfehler — bitte erneut versuchen.");
  }
}

function showSignalSuccess(
  block: HTMLElement | null,
  action: "confirm" | "dispute",
  verified: boolean,
): void {
  if (!block) return;
  const verb = action === "dispute" ? "Notiert" : "Bestätigt";
  const msg = verified ? `✓ ${verb} — danke!` : `${verb}, ohne Vor-Ort-Prüfung — zählt nur leise.`;
  const cls = verified
    ? "border-success/60 bg-success/10 text-success"
    : "border-neon-amber/60 bg-neon-amber/10 text-neon-amber";
  block.outerHTML = `<p class="border-2 ${cls} p-3 text-sm">${escapeHtml(msg)}</p>`;
}

function showSignalError(block: HTMLElement | null, btn: HTMLButtonElement, msg: string): void {
  if (block) {
    block.innerHTML = `<p class="border-2 border-danger/60 bg-danger/10 p-3 text-sm text-danger">${escapeHtml(msg)}</p>`;
    return;
  }
  // Block gone (defensive): at least re-enable so the user can retry.
  btn.disabled = false;
  btn.dataset["signalDone"] = "";
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
      // 409 = duplicate report (same user, kiosk, kind). Server returns a
      // German message; surface it so the user sees why their submit didn't
      // land instead of staring at a silently re-enabled button.
      if (resp.status === 409) {
        const msg = (await resp.text()).trim() || "Bereits gemeldet.";
        form.outerHTML = `<p class="border-2 border-border bg-bg p-4 text-sm italic text-fg-muted">${escapeHtml(msg)}</p>`;
        return;
      }
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
    const html = await resp.text();
    form.outerHTML = html;
  } catch {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Coords {
  lat: number;
  lng: number;
  accuracy?: number;
}

function tryGeolocate(): Promise<Coords | null> {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: Coords | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // Short timeout: we don't want to keep the user staring at a button.
    // If geolocation hasn't returned by then, treat it as "no location given".
    setTimeout(() => settle(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        settle({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      () => settle(null),
      { enableHighAccuracy: true, timeout: 3500, maximumAge: 60_000 },
    );
  });
}
