/**
 * Kiosk detail sheet — opens over the map without reloading. Slides up from
 * the bottom on mobile, in from the right on desktop. URL updates via
 * pushState (so refresh / share / browser-back still work and the full SSR
 * /k/:id page is the no-JS fallback).
 *
 * Vaul-inspired but vanilla — we don't pull in React just for this. The
 * touch drag-to-dismiss lives in ./drag-dismiss (shared with the filter
 * sidebar).
 */

import { installDragToDismiss } from "./drag-dismiss";

const SHEET_ID = "kiosk-sheet";
const BACKDROP_ID = "kiosk-sheet-backdrop";
const BODY_ID = "kiosk-sheet-body";

let openUrl: string | null = null; // /k/<id> while open; null when closed
// True when the user landed directly on /k/:id (initial SSR opens the sheet
// for us, no pushState yet). On close we then push "/" to update the URL.
let pushedHistory = false;
// Bumped by every open or close. Each openSheet snapshots its value before
// the partial fetch and checks again after — if a newer call superseded it,
// it bails. Prevents the race where a backdrop click during an in-flight
// nearby-fetch reopens the sheet when the fetch resolves.
let openSeq = 0;
// Whatever the sidebar's `data-collapsed` was before we hid it for the sheet —
// restored on close so a user who'd manually collapsed it stays collapsed.
let sidebarPrevCollapsed: string | null = null;

function hideSidebarForSheet(): void {
  const sidebar = document.querySelector<HTMLElement>("[data-sidebar]");
  if (!sidebar) return;
  if (sidebarPrevCollapsed === null) {
    sidebarPrevCollapsed = sidebar.dataset["collapsed"] ?? "false";
  }
  sidebar.dataset["collapsed"] = "true";
}

function restoreSidebarFromSheet(): void {
  const sidebar = document.querySelector<HTMLElement>("[data-sidebar]");
  if (!sidebar || sidebarPrevCollapsed === null) return;
  sidebar.dataset["collapsed"] = sidebarPrevCollapsed;
  sidebarPrevCollapsed = null;
}

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function isMapPage(): boolean {
  // Both `/` and `/k/:id` render the same map UI (the latter with the sheet
  // pre-opened). The sheet behaviour should activate on both.
  return (
    location.pathname === "/" || location.pathname === "" || location.pathname.startsWith("/k/")
  );
}

async function fetchPartial(href: string): Promise<string | null> {
  const u = new URL(href, location.origin);
  u.searchParams.set("partial", "1");
  const resp = await fetch(u.toString(), { headers: { accept: "text/html" } });
  if (!resp.ok) return null;
  return resp.text();
}

function setOpen(open: boolean): void {
  const sheet = el(SHEET_ID);
  const backdrop = el(BACKDROP_ID);
  if (!sheet || !backdrop) return;
  sheet.dataset["open"] = open ? "true" : "false";
  backdrop.dataset["open"] = open ? "true" : "false";
  sheet.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.style.overflow = open ? "hidden" : "";
  if (open) hideSidebarForSheet();
  else restoreSidebarFromSheet();
}

function idFromHref(href: string): string | null {
  try {
    const pathname = new URL(href, location.origin).pathname;
    const m = pathname.match(/^\/k\/([^/]+)$/);
    return m ? (m[1] ?? null) : null;
  } catch {
    return null;
  }
}

function dispatchSelection(id: string | null): void {
  window.dispatchEvent(new CustomEvent("tk:selected-kiosk", { detail: { id } }));
}

async function openSheet(href: string, push: boolean): Promise<void> {
  const seq = ++openSeq;
  // Dispatch eagerly so the halo lights up before the fetch resolves.
  dispatchSelection(idFromHref(href));
  const html = await fetchPartial(href);
  // Backdrop-close (or another openSheet call) during the in-flight fetch:
  // a newer event bumped openSeq, so let it own the sheet state and exit.
  if (seq !== openSeq) return;
  if (html === null) {
    // Fallback to full nav if the partial fails.
    location.href = href;
    return;
  }
  const body = el(BODY_ID);
  if (!body) {
    location.href = href;
    return;
  }
  body.innerHTML = html;
  body.scrollTop = 0;
  // Reattach any data-back / data-sheet-close handlers injected into the body.
  attachInBody();
  // "Was the sheet already open before this swap" decides push vs replace.
  // Opening fresh from the map pushes /k/<id> so the back button returns to
  // the map. Swapping between kiosks inside an already-open sheet replaces
  // instead — otherwise each "in der Nähe" click grows the back stack and
  // closing has to walk back through every previous sheet (popstate then
  // re-opens them one by one).
  const wasOpen = openUrl !== null;
  openUrl = href;
  if (push) {
    const u = new URL(href, location.origin);
    if (wasOpen && pushedHistory) {
      history.replaceState({ sheet: href }, "", u.pathname + u.search);
    } else {
      history.pushState({ sheet: href }, "", u.pathname + u.search);
      pushedHistory = true;
    }
  }
  setOpen(true);
}

function closeSheet(viaPop = false): void {
  // Invalidate any in-flight openSheet — see openSeq comment.
  openSeq++;
  if (openUrl === null) return;
  openUrl = null;
  setOpen(false);
  dispatchSelection(null);
  const body = el(BODY_ID);
  if (body) {
    // Delay clearing until after the transition so the user doesn't see
    // a blank flash. 220ms > the 200ms CSS duration.
    setTimeout(() => {
      if (openUrl === null) body.innerHTML = "";
    }, 220);
  }
  if (viaPop) return;
  // history.back() works when we got here via pushState. If the user landed
  // directly on /k/:id, history.back would leave the origin entirely; in
  // that case rewrite the URL to "/" without navigating.
  if (pushedHistory) {
    history.back();
    pushedHistory = false;
  } else if (location.pathname.startsWith("/k/")) {
    history.replaceState(null, "", "/");
  }
}

function attachInBody(): void {
  const body = el(BODY_ID);
  if (!body) return;
  body.querySelectorAll<HTMLAnchorElement>("[data-back], [data-sheet-close]").forEach((a) => {
    if (a.dataset["sheetWired"] === "1") return;
    a.dataset["sheetWired"] = "1";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      closeSheet();
    });
  });
  // Other islands (e.g. CheckinForm in app.entry.ts) hook this to re-bind
  // their listeners after a sheet swap.
  window.dispatchEvent(new CustomEvent("tk:sheet-body-swapped"));
}

// ── installation ────────────────────────────────────────────────────────────

export function installKioskSheet(): void {
  if (!isMapPage()) return;
  const sheetEl = el(SHEET_ID);
  if (!sheetEl) return;

  // SSR may have pre-opened the sheet (legacy path; current /k/:id is
  // standalone, but keep the branch in case any other route ever wants
  // to land with the sheet open).
  if (sheetEl.dataset["open"] === "true") {
    openUrl = sheetEl.dataset["initialHref"] ?? location.pathname;
    pushedHistory = false;
    attachInBody();
    document.body.style.overflow = "hidden";
    dispatchSelection(idFromHref(openUrl));
  }

  // Delegated click handler: any <a href="/k/...">. Also focuses the map on
  // the kiosk when the anchor carries data-lng / data-lat (list items have
  // them; map-marker clicks bypass this path via tk:open-kiosk directly).
  document.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest(
      "a[href^='/k/']",
    ) as HTMLAnchorElement | null;
    if (!target) return;
    if (target.target === "_blank") return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    const href = target.getAttribute("href");
    if (!href) return;
    ev.preventDefault();
    const lng = parseFloat(target.dataset["lng"] ?? "");
    const lat = parseFloat(target.dataset["lat"] ?? "");
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      window.dispatchEvent(new CustomEvent("tk:focus-kiosk", { detail: { lng, lat } }));
    }
    void openSheet(href, true);
  });

  // Map markers dispatch this when a single (non-cluster) point is clicked.
  window.addEventListener("tk:open-kiosk", (ev) => {
    const id = (ev as CustomEvent<{ id: string }>).detail?.id;
    if (!id) return;
    void openSheet(`/k/${id}`, true);
  });

  // Backdrop click + close button.
  el(BACKDROP_ID)?.addEventListener("click", () => closeSheet());
  document.addEventListener("click", (ev) => {
    const closer = (ev.target as HTMLElement | null)?.closest("[data-sheet-close]");
    if (closer && el(SHEET_ID)?.contains(closer)) {
      ev.preventDefault();
      closeSheet();
    }
  });

  // ESC closes on desktop.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && openUrl !== null) closeSheet();
  });

  // browser-back + forward
  window.addEventListener("popstate", () => {
    // If we're back at the map path, ensure the sheet is closed.
    if (isMapPage() && openUrl !== null) closeSheet(true);
    // If user forward-navigates to a /k/:id we previously pushed, re-open it.
    else if (location.pathname.startsWith("/k/") && openUrl === null) {
      void openSheet(location.pathname + location.search, false);
    }
  });

  // If the page loaded at /k/... directly, the SSR full page is rendered —
  // we don't intercept that. The sheet only activates from the map page.

  installSheetDrag();
}

// ── touch drag-to-dismiss (mobile only) ─────────────────────────────────────

function installSheetDrag(): void {
  const sheet = el(SHEET_ID);
  if (!sheet) return;
  const handle = sheet.querySelector<HTMLElement>("[data-drag-handle]");
  // The inner panel is the only direct child (the backdrop is a sibling of
  // #kiosk-sheet); its height sets the dismiss distance.
  const panel = sheet.querySelector<HTMLElement>(":scope > div");
  if (!handle || !panel) return;

  installDragToDismiss({
    handle,
    target: sheet,
    measure: panel,
    threshold: 0.3,
    onDismiss: closeSheet,
  });
}
