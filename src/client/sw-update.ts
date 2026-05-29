/**
 * Service-worker registration + update prompt.
 *
 * The SW (public/sw.js) no longer auto-`skipWaiting`s, so a new deploy installs
 * into the "waiting" state instead of swapping bundles under the running page.
 * This module notices the waiting worker and shows a small reload toast; on
 * accept it tells the worker to take over (`SKIP_WAITING`), waits for the
 * browser's `controllerchange`, then reloads onto the fresh bundle.
 *
 * Why this exists: previously an open tab could run an old cached JS bundle
 * indefinitely (the "I press the button and nothing happens" stale-bundle bug),
 * since registration happened once and never re-checked. We now also poll
 * `reg.update()` whenever the tab regains focus, so long-lived tabs notice
 * within one focus instead of never.
 */

export function installServiceWorker(): void {
  if (!("serviceWorker" in navigator) || location.protocol !== "https:") return;

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => wireUpdateFlow(reg))
      .catch((err) => console.warn("SW registration failed:", err));
  });

  // A controllerchange means a new SW has taken control — reload once so the
  // page runs against the new bundle. Guard against the reload loop that fires
  // on the very first SW activation (no prior controller).
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function wireUpdateFlow(reg: ServiceWorkerRegistration): void {
  // An update may already be parked before this code runs.
  if (reg.waiting && navigator.serviceWorker.controller) {
    showUpdateToast(reg);
  }

  reg.addEventListener("updatefound", () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      // "installed" + an existing controller = an update (not first install).
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        showUpdateToast(reg);
      }
    });
  });

  // Long-lived tabs: re-check for a new SW when the tab regains focus.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reg.update();
  });
}

const TOAST_ID = "tk-sw-update-toast";

function showUpdateToast(reg: ServiceWorkerRegistration): void {
  // Guard on DOM presence rather than a latch, so a toast the user dismissed
  // can reappear if a further update lands later in the same session.
  if (document.getElementById(TOAST_ID)) return;

  const toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.setAttribute("role", "status");
  toast.className =
    "fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-md items-center gap-3 border-2 border-neon-pink bg-surface p-3 text-sm text-fg shadow-[var(--shadow-glow-pink)] sm:left-auto sm:right-3";

  const label = document.createElement("span");
  label.className = "flex-1";
  label.textContent = "Neue Version verfügbar.";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className =
    "shrink-0 cursor-pointer border-2 border-neon-pink bg-neon-pink px-3 py-1 font-bold uppercase tracking-wider text-bg hover:opacity-90";
  reload.textContent = "Neu laden";
  reload.addEventListener("click", () => {
    reload.disabled = true;
    reload.textContent = "Lädt …";
    const worker = reg.waiting ?? reg.active;
    // If the worker is already controlling (edge case), just reload.
    if (worker) worker.postMessage({ type: "SKIP_WAITING" });
    else window.location.reload();
  });

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "shrink-0 cursor-pointer px-2 py-1 text-fg-dim hover:text-fg";
  dismiss.setAttribute("aria-label", "Schließen");
  dismiss.textContent = "✕";
  dismiss.addEventListener("click", () => toast.remove());

  toast.appendChild(label);
  toast.appendChild(reload);
  toast.appendChild(dismiss);
  document.body.appendChild(toast);
}
