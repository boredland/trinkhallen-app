import { manifest } from "./manifest.generated";

/**
 * Resolve a client entry-point name to its public URLs.
 *
 * - **Dev** (`import.meta.env.DEV`): returns the live source paths so Vite's
 *   middleware can serve them with HMR.
 * - **Prod**: returns hashed paths from the Vite manifest. The manifest is
 *   embedded into the Worker bundle by `scripts/write-asset-manifest.ts`,
 *   which runs between the client and worker builds.
 */
export type ClientEntry = "app" | "map" | "pick";

export interface AssetUrls {
  js: string;
  css: string[];
}

export function asset(entry: ClientEntry): AssetUrls {
  if (import.meta.env.DEV) {
    return {
      js: `/src/client/${entry}.entry.ts`,
      css: entry === "app" ? ["/src/client/app.css"] : [],
    };
  }
  const key = `src/client/${entry}.entry.ts`;
  const e = manifest[key];
  if (!e) throw new Error(`asset manifest missing entry: ${key}`);
  return {
    js: `/${e.file}`,
    css: (e.css ?? []).map((c) => `/${c}`),
  };
}
