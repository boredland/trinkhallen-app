//! The asset manifest is produced by `trinkhallen-importer assets` during the
//! full build and is not committed (it changes with every client build). A
//! plain `cargo check`/`cargo test` on a fresh clone still needs the module,
//! so an empty one is written when the importer hasn't run.

use std::path::Path;

fn main() {
    let manifest = Path::new("src/assets_manifest.rs");
    println!("cargo::rerun-if-changed=src/assets_manifest.rs");
    if !manifest.exists() {
        std::fs::write(
            manifest,
            "// @generated placeholder — run scripts/build-dioxus.sh for real asset URLs.\n\n\
             pub const CSS: &[&str] = &[];\n\
             pub const CLIENT_JS: &str = \"\";\n\
             pub const CLIENT_WASM: &str = \"\";\n\
             pub const MAP_JS: &str = \"\";\n",
        )
        .expect("write placeholder asset manifest");
    }
}
