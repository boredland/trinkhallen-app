/**
 * Lazy-mounts the @khmyznikov/pwa-install web component for iOS Safari users.
 *
 * iOS doesn't expose `beforeinstallprompt` like Chrome does, so the only path
 * to a home-screen install is the Safari Share Sheet → "Add to Home Screen".
 * The component renders a localised tutorial card pointing at the share icon;
 * for everyone else (Android Chrome, desktop, in-app browsers) we don't mount
 * it at all — the cost is a single UA check.
 */

import { resolveLang, t } from "../lib/messages";

const STORAGE_KEY = "tk-install-prompt-dismissed-at";
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // a week between nags

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const isIDevice =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isIDevice && isSafari;
}

function isStandalone(): boolean {
  // Older iOS exposes `navigator.standalone`; modern browsers report the
  // PWA display mode via matchMedia.
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

function recentlyDismissed(): boolean {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  const t = Number(raw);
  return Number.isFinite(t) && Date.now() - t < DISMISS_COOLDOWN_MS;
}

export async function setupIosInstallPrompt(): Promise<void> {
  if (!isIosSafari() || isStandalone() || recentlyDismissed()) return;

  // Heavy import — only paid by likely-iOS-Safari users on their first visit
  // since dismissal. Vite code-splits this into its own chunk.
  await import("@khmyznikov/pwa-install");

  const lang = resolveLang(document.documentElement.lang);
  const el = document.createElement("pwa-install");
  el.setAttribute("manifest-url", "/manifest.webmanifest");
  el.setAttribute("name", "trinkhallen");
  el.setAttribute("description", t(lang, "client.install.description"));
  el.setAttribute("install-description", t(lang, "client.install.installDescription"));
  el.setAttribute("disable-screenshots", "");
  // Dark-theme mapping. Library exposes these as CSS custom properties; the
  // `styles` attribute takes a JSON object and re-applies on every render.
  el.setAttribute(
    "styles",
    JSON.stringify({
      "--tint-color": "#5ee2ff",
      "--background-color": "#141414",
      "--background-color-primary": "#141414",
      "--background-color-button": "#5ee2ff",
      "--background-color-button-active": "#37c8e6",
      "--background-color-ripple": "rgba(94, 226, 255, 0.18)",
      "--base-color": "#1f1f1f",
      "--text-color-normal": "#f5f2ec",
      "--text-color-primary": "#f5f2ec",
      "--text-color-secondary": "#a8a39a",
      "--text-color-description": "#a8a39a",
      "--text-color-button": "#0a0a0a",
      "--touch-header-color": "#0a0a0a",
      "--divider-buttons-color": "#2a2a2a",
      "--border-bottom-color": "#2a2a2a",
      "--icon-how-to-color": "#5ee2ff",
      "--nav-btn-background-color": "#1f1f1f",
      "--nav-btn-fill-color": "#5ee2ff",
    }),
  );

  el.addEventListener("pwa-user-choice-result-event", (e: Event) => {
    const detail = (e as CustomEvent<{ message: string }>).detail;
    if (detail?.message === "dismissed") {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    }
  });

  document.body.appendChild(el);

  // The library doesn't expose ::part hooks, so we patch the shadow DOM
  // directly. The German "Hinzufügen zum Startbildschirm" overruns the
  // hard-coded button styling (the inner span has text-overflow:ellipsis +
  // nowrap that wins over our default rule). Drop font-size and override
  // the truncation so the full label fits.
  customElements.whenDefined("pwa-install").then(() => {
    const apply = (): boolean => {
      const sr = el.shadowRoot;
      if (!sr || sr.querySelector("#tk-shadow-overrides")) return false;
      const style = document.createElement("style");
      style.id = "tk-shadow-overrides";
      style.textContent = `
        button.dialog-button.install,
        button.dialog-button.button.install {
          font-size: 14px !important;
          letter-spacing: 0 !important;
          padding-inline: 12px !important;
        }
        button.dialog-button.install span.button-text,
        button.dialog-button.install span.button-text > span {
          white-space: nowrap !important;
          text-overflow: clip !important;
          overflow: visible !important;
        }
      `;
      sr.appendChild(style);
      return true;
    };
    // Shadow root populates over multiple microtasks + a 500 ms Apple
    // auto-trigger; poll briefly and bail once we've injected.
    const iv = setInterval(() => {
      if (apply()) clearInterval(iv);
    }, 100);
    setTimeout(() => clearInterval(iv), 5000);
  });
}
