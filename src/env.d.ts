/// <reference types="@cloudflare/workers-types" />
/// <reference types="vite/client" />

export interface Env {
  // Bindings
  DB: D1Database;
  ASSETS: Fetcher;
  EMAIL: SendEmail;

  // Vars
  PUBLIC_ORIGIN: string;

  // Secrets — some may be empty in dev / before operator setup
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
}

declare module "hono" {
  interface ContextVariableMap {
    user?: {
      id: string;
      email: string;
      username: string | null;
      displayName: string | null;
      avatarUrl: string | null;
      role: "user" | "moderator" | "admin";
    };
  }
}
