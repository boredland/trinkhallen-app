#!/usr/bin/env bash
# Single build entry for the Dioxus port (local, CI and Cloudflare Workers
# Builds). Produces dist/static (Workers Assets) and crates/worker/build
# (the Worker bundle). Safe to re-run.
set -euo pipefail

RUST_VERSION="1.98.1"
WORKER_BUILD_VERSION="0.8.7"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Workers Builds has no Rust toolchain. Cargo is installed to $HOME, which
# the build image keeps between runs, so this is a no-op after the first build.
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "==> installing Rust ${RUST_VERSION}"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" --target wasm32-unknown-unknown
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
# rust-toolchain pinning is not used, so make sure the pinned toolchain and
# the wasm target exist even when cargo came with the image.
if ! rustup run "${RUST_VERSION}" rustc --version >/dev/null 2>&1; then
  rustup toolchain install "${RUST_VERSION}" --profile minimal
fi
rustup default "${RUST_VERSION}" >/dev/null
rustup target add wasm32-unknown-unknown --toolchain "${RUST_VERSION}"

# worker-build wraps wasm-bindgen + wasm-opt and fetches matching binaries
# itself. binstall gives a prebuilt binary; when none fits the platform it
# compiles from source, which needs libssl-dev and pkg-config (present on
# Workers Builds, install them in a bare container).
if ! worker-build --version 2>/dev/null | grep -q "${WORKER_BUILD_VERSION}"; then
  echo "==> installing worker-build ${WORKER_BUILD_VERSION}"
  if ! command -v cargo-binstall >/dev/null 2>&1; then
    curl -L --proto '=https' --tlsv1.2 -sSf \
      https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash
  fi
  cargo binstall --no-confirm --force "worker-build@${WORKER_BUILD_VERSION}"
fi

echo "==> importing data"
cargo run --release --locked -p trinkhallen-importer -- data

# The assets step refuses a directory holding two hashed builds of one entry,
# so every run starts from an empty one.
rm -rf dist/static/assets
mkdir -p dist/static/assets

echo "==> building client assets"
bash crates/client/build.sh dist/static/assets

echo "==> hashing assets"
cargo run --release --locked -p trinkhallen-importer -- assets dist/static/assets

# public/ carries the authoritative _headers plus sw.js, icons and manifests;
# it is copied after the data step because that step only owns dist/static/data
# and sitemap.xml.
echo "==> copying public/"
cp -R public/. dist/static/

echo "==> building worker"
(cd crates/worker && worker-build --release)

echo "==> done"
