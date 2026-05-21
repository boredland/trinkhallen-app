import Alpine from "alpinejs";
import "./app.css";
import "maplibre-gl/dist/maplibre-gl.css";

// Self-hosted fonts — latin + latin-ext (German umlauts live in latin-ext).
// Vite hashes the .woff2 files into dist/static/assets/ and emits a
// `@font-face` rule per import, so the basemap and the chrome no longer
// reach out to fonts.googleapis.com.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/inter/latin-ext-600.css";
import "@fontsource/inter/latin-ext-700.css";
import "@fontsource/anton/latin-400.css";
import "@fontsource/anton/latin-ext-400.css";
import { installKioskSheet } from "./sheet";

// ── Theme toggle ────────────────────────────────────────────────────────────
const root = document.documentElement;
const stored = localStorage.getItem("tk-theme");
if (stored === "light" || stored === "dark") root.dataset.theme = stored;

// Glyph reflects the mode you'd switch TO (sun when currently dark, moon when
// currently light). Updated on initial paint and on every toggle.
const SUN = "☀";
const MOON = "☾";
function paintThemeIcons(): void {
  const glyph = root.dataset["theme"] === "light" ? MOON : SUN;
  document.querySelectorAll<HTMLElement>("[data-theme-icon]").forEach((el) => {
    el.textContent = glyph;
  });
}
paintThemeIcons();

document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;
    localStorage.setItem("tk-theme", next);
    paintThemeIcons();
    // Map islands listen and reload their style to match.
    window.dispatchEvent(new CustomEvent("tk:theme-changed", { detail: next }));
  });
});

// ── Filter form ─────────────────────────────────────────────────────────────
//
// Chip <label>s wrap checkboxes whose names are e.g. `pay_cards`, `tag_wc`,
// `open_now`. We translate that on submit into the URL shape the server
// expects: `?pay=cards,contactless&tags=wc&open_now=1&q=…`.
//
// Each change rewrites the URL via replaceState, fires `tk:filters-changed`
// so the map can refetch, and swaps the side panel HTML via fetch.

function buildFilterQuery(form: HTMLFormElement): URLSearchParams {
  const fd = new FormData(form);
  const pay: string[] = [];
  const tags: string[] = [];
  for (const [name, value] of fd.entries()) {
    if (typeof value !== "string") continue;
    if (name.startsWith("pay_")) pay.push(name.slice(4));
    else if (name.startsWith("tag_")) tags.push(name.slice(4));
  }
  const params = new URLSearchParams();
  if (pay.length) params.set("pay", pay.join(","));
  if (tags.length) params.set("tags", tags.join(","));
  if (fd.get("open_now")) params.set("open_now", "1");
  if (fd.get("needs_hours")) params.set("needs_hours", "1");
  const q = (fd.get("q") as string | null)?.trim();
  if (q) params.set("q", q);
  return params;
}

async function refreshPanel(params: URLSearchParams): Promise<void> {
  const panel = document.getElementById("kiosk-panel");
  if (!panel) return;
  const baseUrl = panel.dataset["panelUrl"];
  if (!baseUrl) return;
  const url = new URL(baseUrl, location.origin);
  for (const [k, v] of params.entries()) url.searchParams.set(k, v);
  for (const k of ["pay", "tags", "open_now", "needs_hours", "q"]) {
    if (!params.has(k)) url.searchParams.delete(k);
  }
  const resp = await fetch(url.toString(), { headers: { accept: "text/html" } });
  if (resp.ok) panel.innerHTML = await resp.text();
}

function attachFilterForm(form: HTMLFormElement): void {
  // Reflect URL into chip state on initial load (covers bfcache restore).
  const params = new URL(location.href).searchParams;
  const pay = new Set((params.get("pay") ?? "").split(",").filter(Boolean));
  const tags = new Set((params.get("tags") ?? "").split(",").filter(Boolean));
  form.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((input) => {
    if (input.name.startsWith("pay_")) input.checked = pay.has(input.name.slice(4));
    else if (input.name.startsWith("tag_")) input.checked = tags.has(input.name.slice(4));
    else if (input.name === "open_now") input.checked = params.get("open_now") === "1";
    else if (input.name === "needs_hours") input.checked = params.get("needs_hours") === "1";
  });

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const submit = () => {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(() => {
      const next = buildFilterQuery(form);
      const u = new URL(location.href);
      u.search = next.toString();
      history.replaceState(null, "", u.toString());
      window.dispatchEvent(new CustomEvent("tk:filters-changed", { detail: next }));
      void refreshPanel(next);
    }, 150);
  };

  form.addEventListener("change", submit);
  form.addEventListener("input", (e) => {
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") submit();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
}

document.querySelectorAll<HTMLFormElement>("[data-filter-form]").forEach(attachFilterForm);

// ── Sidebar collapse/expand ─────────────────────────────────────────────────
// Persists across page loads so a user who prefers map-only stays in
// map-only mode. The map page renders both control elements; they're
// no-ops on other routes (querySelectorAll returns empty).
(function setupSidebar() {
  const sidebar = document.querySelector<HTMLElement>("[data-sidebar]");
  const expandBtn = document.querySelector<HTMLElement>("[data-sidebar-expand]");
  if (!sidebar || !expandBtn) return;
  const setCollapsed = (collapsed: boolean) => {
    sidebar.dataset["collapsed"] = collapsed ? "true" : "false";
    expandBtn.dataset["show"] = collapsed ? "true" : "false";
    localStorage.setItem("tk-sidebar-collapsed", collapsed ? "1" : "0");
  };
  if (localStorage.getItem("tk-sidebar-collapsed") === "1") setCollapsed(true);
  document
    .querySelectorAll<HTMLButtonElement>("[data-sidebar-collapse]")
    .forEach((b) => b.addEventListener("click", () => setCollapsed(true)));
  expandBtn.addEventListener("click", () => setCollapsed(false));
})();

// ── data-back links: prefer history.back() when we came from same-origin ────
// Lets the back link on /k/:id pop us back to the exact map viewport the
// user was looking at, instead of resetting to the home default.
document.querySelectorAll<HTMLAnchorElement>("[data-back]").forEach((el) => {
  el.addEventListener("click", (e) => {
    if (document.referrer.startsWith(location.origin) && history.length > 1) {
      e.preventDefault();
      history.back();
    }
  });
});

// ── Report form: show only the fieldset matching the selected `kind` ────────
document.querySelectorAll("[data-report-form]").forEach((root) => {
  const select = root.querySelector("select[name=kind]") as HTMLSelectElement | null;
  if (!select) return;
  const fieldsets = root.querySelectorAll("fieldset[data-kind]") as NodeListOf<HTMLFieldSetElement>;
  const apply = () => {
    const kind = select.value;
    fieldsets.forEach((fs) => {
      fs.classList.toggle("hidden", fs.dataset["kind"] !== kind);
    });
  };
  select.addEventListener("change", apply);
  apply();
});

// Bridge bbox changes from the map into the panel's data-panel-url, so the
// next filter change hits the right bbox.
window.addEventListener("tk:bbox-changed", (e) => {
  const panel = document.getElementById("kiosk-panel");
  if (!panel) return;
  const detail = (e as CustomEvent<{ bbox: string }>).detail;
  const u = new URL(panel.dataset["panelUrl"] ?? "/api/kiosks/panel", location.origin);
  u.searchParams.set("bbox", detail.bbox);
  panel.dataset["panelUrl"] = u.pathname + u.search;
  void refreshPanel(new URLSearchParams(location.search));
});

// When the user clicks geolocate on the map, the GeolocateControl emits
// coordinates that we want to thread into the sidebar fetch so the list
// re-sorts by distance from the user. The `origin` param sticks to
// data-panel-url so subsequent bbox/filter changes keep the sort.
window.addEventListener("tk:origin-changed", (e) => {
  const panel = document.getElementById("kiosk-panel");
  if (!panel) return;
  const { lat, lng } = (e as CustomEvent<{ lat: number; lng: number }>).detail;
  const u = new URL(panel.dataset["panelUrl"] ?? "/api/kiosks/panel", location.origin);
  u.searchParams.set("origin", `${lat.toFixed(5)},${lng.toFixed(5)}`);
  panel.dataset["panelUrl"] = u.pathname + u.search;
  void refreshPanel(new URLSearchParams(location.search));
});

// Kiosk detail sheet — only attaches if the map-page sheet container is
// present in the DOM.
installKioskSheet();

// Service worker — caches assets + tile bytes for fast repeat visits
// and basic offline (last map view + last viewed pages stay accessible).
if ("serviceWorker" in navigator && location.protocol === "https:") {
  // Defer until after first paint to not contend with critical bundles.
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => console.warn("SW registration failed:", err));
  });
}

// Only spin Alpine up when the page actually carries `[x-data]` directives.
// SSR detail pages and most static routes have none and don't need ~30 KB of
// reactive engine running.
if (document.querySelector("[x-data]")) {
  // biome-ignore lint/suspicious/noExplicitAny: Alpine attaches itself to window with no shipped type
  (window as any).Alpine = Alpine;
  Alpine.start();
}
