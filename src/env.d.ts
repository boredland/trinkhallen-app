/// <reference types="@cloudflare/workers-types" />
/// <reference types="vite/client" />

export interface Env {
  // Bindings
  DB: D1Database;
  TILES: R2Bucket;
  ASSETS: Fetcher;

  // Vars
  PUBLIC_ORIGIN: string;

  // Secrets
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_WEBHOOK_SECRET: string;
}

declare module "hono" {
  interface ContextVariableMap {
    user?: { id: string; email: string; displayName: string | null; role: "user" | "moderator" | "admin" };
  }
}
