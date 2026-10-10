#!/usr/bin/env bash
# Build the browser bundle of the Dioxus port into an output directory:
#
#   <out>/client.js       wasm-bindgen ES-module glue
#   <out>/client_bg.wasm  optimized wasm
#   <out>/client_snippets/…   glue support modules emitted by wasm-bindgen
#   <out>/map.js          esbuild bundle of web/map.js + maplibre-gl
#   <out>/pwa.js          esbuild bundle of the lazy install-prompt component
#                         (plus its dynamic-import chunk, if any)
#   <out>/app.css         Tailwind build of web/app.css (+ maplibre + fonts)
#   <out>/fonts/*         @fontsource woff2 files referenced by app.css
#
# Usage: bash crates/client/build.sh <out-dir>
#
# Content hashing + the asset manifest are the integrator's job (see
# docs/dioxus-port-contracts.md); every emitted file is named deterministically
# so hashing can rename them afterwards.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: bash crates/client/build.sh <out-dir>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
cd "$ROOT"

# Pinned tool binaries, shared with worker-build's cache (same versions it
# downloads) — see docs/dioxus-port.md ("NEVER set strip = true").
TOOLS="$HOME/.cache/worker-build"
WB_DIR="$TOOLS/wasm-bindgen-x86_64-unknown-linux-musl-0.2.129"
WO_DIR="$TOOLS/wasm-opt-x86_64-linux-132"
WASM_BINDGEN="${WASM_BINDGEN:-$WB_DIR/wasm-bindgen}"
WASM_OPT="${WASM_OPT:-$WO_DIR/bin/wasm-opt}"
# A cold machine (CI, Workers Builds) hasn't run worker-build yet, which is
# what normally fills this cache.
if [ ! -x "$WASM_BINDGEN" ]; then
  mkdir -p "$WB_DIR"
  curl -fsSL https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.129/wasm-bindgen-0.2.129-x86_64-unknown-linux-musl.tar.gz |
    tar -xz -C "$WB_DIR" --strip-components=1
fi
if [ ! -x "$WASM_OPT" ]; then
  mkdir -p "$WO_DIR"
  curl -fsSL https://github.com/WebAssembly/binaryen/releases/download/version_132/binaryen-version_132-x86_64-linux.tar.gz |
    tar -xz -C "$WO_DIR" --strip-components=1
fi
ESBUILD="${ESBUILD:-bunx esbuild@0.25}"
TAILWIND="${TAILWIND:-bunx @tailwindcss/cli@4}"

echo "==> cargo build -p trinkhallen-client --target wasm32-unknown-unknown --release"
cargo build -p trinkhallen-client --target wasm32-unknown-unknown --release

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> wasm-bindgen --target web --out-name client"
"$WASM_BINDGEN" \
  --target web \
  --out-name client \
  --out-dir "$STAGE" \
  --no-typescript \
  target/wasm32-unknown-unknown/release/trinkhallen_client.wasm

echo "==> wasm-opt -Oz"
"$WASM_OPT" \
  -Oz \
  --enable-bulk-memory \
  --enable-nontrapping-float-to-int \
  --enable-reference-types \
  --enable-sign-ext \
  -o "$OUT/client_bg.wasm" \
  "$STAGE/client_bg.wasm"

# The glue + any snippet modules wasm-bindgen emitted alongside it. They are
# imported relatively (`./client_bg.wasm`, `./snippets/…`, `./map.js`,
# `./pwa.js`), so they have to live in the same directory as the wasm.
cp "$STAGE/client.js" "$OUT/client.js"
if [ -d "$STAGE/snippets" ]; then
  rm -rf "$OUT/snippets"
  cp -R "$STAGE/snippets" "$OUT/snippets"
fi

echo "==> esbuild web/map.js + maplibre-gl"
$ESBUILD web/map.js --bundle --format=esm --minify --outfile="$OUT/map.js"

# The install prompt is a dynamic import() from the client glue (iOS Safari
# only). esbuild splitting keeps the component in its own chunk so the chunk
# boundary matches the lazy load.
echo "==> esbuild web/pwa.js + @khmyznikov/pwa-install"
$ESBUILD web/pwa.js --bundle --format=esm --minify --splitting --outdir="$OUT"

echo "==> tailwindcss web/app.css"
$TAILWIND -i web/app.css -o "$OUT/app.css" --minify

# @fontsource CSS references `url(./files/…)` relative to its own package; the
# build flattens those to `<out>/fonts/` and rewrites the URLs so one app.css
# covers fonts + maplibre + design tokens.
echo "==> copying @fontsource files"
mkdir -p "$OUT/fonts"
node - "$OUT/app.css" <<'EOF'
const fs = require("fs");
const path = require("path");
const outCss = process.argv[2];
const root = process.cwd();
let css = fs.readFileSync(outCss, "utf8");
const seen = new Set();
css = css.replace(/url\(\.\/files\/([^)]+)\)/g, (whole, file) => {
  if (seen.has(file)) return `url(./fonts/${file})`;
  const hit = ["inter", "anton"]
    .map((pkg) => path.join(root, "node_modules", "@fontsource", pkg, "files", file))
    .find((p) => fs.existsSync(p));
  if (!hit) {
    console.error(`font file not found: ${file}`);
    process.exit(1);
  }
  fs.copyFileSync(hit, path.join(path.dirname(outCss), "fonts", file));
  seen.add(file);
  return `url(./fonts/${file})`;
});
fs.writeFileSync(outCss, css);
EOF

echo "==> done: $OUT"
ls -la "$OUT"
