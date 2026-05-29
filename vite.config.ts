import build from "@hono/vite-build/cloudflare-workers";
import devServer from "@hono/vite-dev-server";
import adapter from "@hono/vite-dev-server/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const isClient = mode === "client";

  if (isClient) {
    // Client island bundles (map, alpine bootstrap) + the Tailwind stylesheet.
    return {
      plugins: [tailwindcss()],
      build: {
        manifest: true,
        outDir: "dist/static",
        emptyOutDir: false,
        rollupOptions: {
          input: {
            app: "/src/client/app.entry.ts",
            map: "/src/client/map.entry.ts",
            pick: "/src/client/pick.entry.ts",
          },
          output: {
            entryFileNames: "assets/[name]-[hash].js",
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name]-[hash].[ext]",
            // Pull MapLibre into its own named chunk so the SW cache key is
            // stable across deploys that touch only our own client code.
            manualChunks: {
              maplibre: ["maplibre-gl"],
            },
          },
        },
      },
    };
  }

  // Worker build (SSR Hono app).
  return {
    plugins: [
      build({
        entry: "src/index.ts",
        outputDir: "dist",
        minify: true,
        external: ["cloudflare:email", "cloudflare:workers", "cloudflare:sockets"],
      }),
      devServer({
        adapter,
        entry: "src/index.ts",
        exclude: [
          /^\/assets\/.+/,
          /^\/static\/.+/,
          /^\/src\/.+/, // vite serves the client entries + their CSS imports
          /^\/@.+$/,
          /^\/node_modules\/.*/,
        ],
      }),
      tailwindcss(),
      // Self-signed HTTPS in dev — needed because `__Host-tk_sess` is a Secure
      // cookie that browsers refuse to set over `http://127.0.0.1`. Production
      // already terminates TLS at Cloudflare so this only fires for `vite`.
      basicSsl(),
    ],
    ssr: {
      // `cloudflare:email` etc. are Workers runtime virtuals — the bundler
      // must leave them as bare imports for workerd to resolve at runtime.
      external: ["cloudflare:email", "cloudflare:workers", "cloudflare:sockets"],
    },
  };
});
