/**
 * Loader for @khmyznikov/pwa-install — bundled by esbuild into `pwa.js` next
 * to the wasm client glue and imported lazily (only iOS Safari users ever ask
 * for it). Keep this file dependency-light: everything in here lands in the
 * chunk that the install prompt pulls in.
 */
import "@khmyznikov/pwa-install";

/**
 * @param {string} attrsJson attributes for the <pwa-install> element:
 *   manifest-url, name, description, install-description, disable-screenshots,
 *   styles (JSON object), dismiss-key (localStorage key for "asked again").
 */
export async function mountPwaInstall(attrsJson) {
  const attrs = JSON.parse(attrsJson);
  const dismissKey = attrs["dismiss-key"] ?? "tk-install-prompt-dismissed-at";

  const el = document.createElement("pwa-install");
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "styles") el.setAttribute(key, JSON.stringify(value));
    else if (key !== "dismiss-key") el.setAttribute(key, String(value));
  }

  el.addEventListener("pwa-user-choice-result-event", (e) => {
    if (e.detail?.message === "dismissed") {
      localStorage.setItem(dismissKey, String(Date.now()));
    }
  });

  document.body.appendChild(el);

  // The library doesn't expose ::part hooks, so the shadow DOM is patched
  // directly. The German "Hinzufügen zum Startbildschirm" overruns the
  // hard-coded button styling (the inner span has text-overflow:ellipsis +
  // nowrap that wins over our default rule). Drop font-size and override
  // the truncation so the full label fits.
  customElements.whenDefined("pwa-install").then(() => {
    const apply = () => {
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
