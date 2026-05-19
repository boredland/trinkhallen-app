import Alpine from "alpinejs";
import "htmx.org";
import "./app.css";

// Dark/light toggle — pure CSS variable swap via [data-theme] on <html>.
const root = document.documentElement;
const stored = localStorage.getItem("tk-theme");
if (stored === "light" || stored === "dark") root.dataset.theme = stored;

document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;
    localStorage.setItem("tk-theme", next);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).Alpine = Alpine;
Alpine.start();
