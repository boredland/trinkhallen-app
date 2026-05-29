/**
 * "App aktualisieren" escape hatch.
 *
 * The service worker (public/sw.js) caches hashed JS/CSS bundles cache-first
 * and SSR HTML stale-while-revalidate. A VERSION bump invalidates everything
 * on the next visit, but a user staring at an already-open tab with a stale
 * bundle has no in-app way to force the issue. This button is that way:
 * delete every Cache Storage entry, unregister all service workers, then do a
 * cache-busting reload so the next load pulls fresh HTML + bundles.
 *
 * Document-level delegation (matches checkin.ts) so it survives sheet swaps.
 */

let installed = false;

export function installRefreshButton(): void {
  if (installed) return;
  installed = true;

  document.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-tk-refresh]");
    if (!btn) return;
    ev.preventDefault();
    void hardRefresh(btn);
  });
}

async function hardRefresh(btn: HTMLButtonElement): Promise<void> {
  if (btn.dataset["busy"] === "1") return;
  btn.dataset["busy"] = "1";
  const original = btn.textContent;
  btn.textContent = "Aktualisiere …";
  btn.setAttribute("aria-busy", "true");

  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (err) {
    // Even if cache/SW teardown partially fails, the reload below still pulls
    // fresh HTML (the SW is gone or its caches are emptied), so press on.
    console.warn("refresh teardown incomplete:", err);
  }

  // Cache-busting query param defeats any HTTP/memory cache the SW didn't own.
  const url = new URL(window.location.href);
  url.searchParams.set("_r", String(Date.now()));
  window.location.replace(url.toString());
  // location.replace doesn't restore button state — but we're navigating away.
  void original;
}
