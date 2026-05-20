import build from "@hono/vite-build/cloudflare-workers";
import devServer from "@hono/vite-dev-server";
import adapter from "@hono/vite-dev-server/cloudflare";
import tailwindcss from "@tailwindcss/vite";
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
            "app": "/src/client/app.entry.ts",
            "map": "/src/client/map.entry.ts",
            "pick": "/src/client/pick.entry.ts",
          },
          output: {
            entryFileNames: "assets/[name]-[hash].js",
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name]-[hash].[ext]",
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
        exclude: [/^\/assets\/.+/, /^\/static\/.+/, /^\/@.+$/, /^\/node_modules\/.*/],
      }),
      tailwindcss(),
    ],
    ssr: {
      // `cloudflare:email` etc. are Workers runtime virtuals — the bundler
      // must leave them as bare imports for workerd to resolve at runtime.
      external: ["cloudflare:email", "cloudflare:workers", "cloudflare:sockets"],
    },
  };
});
