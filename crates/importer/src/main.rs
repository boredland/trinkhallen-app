//! Build-time importer. Run from the repository root:
//!
//! ```text
//! cargo run -p trinkhallen-importer --release -- data
//! cargo run -p trinkhallen-importer --release -- assets dist/static/assets
//! ```

mod assets;
mod data;
mod json;
mod regions;
mod sitemap;
mod supercluster;

use std::path::Path;
use std::process::ExitCode;

const STATIC_DIR: &str = "dist/static";
const GENERATED_REGIONS: &str = "crates/core/src/regions/generated.rs";
const ASSETS_MANIFEST: &str = "crates/worker/src/assets_manifest.rs";

fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("data") => {
            println!("Importing trinkhallen-data…");
            let src = data::resolve_source_dir()?;
            let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
            data::import(
                &src,
                Path::new(STATIC_DIR),
                Path::new(GENERATED_REGIONS),
                &today,
            )
            .map(drop)
        }
        Some("assets") => {
            let dir = args.get(1).ok_or("usage: assets <dir>")?;
            assets::run(Path::new(dir), Path::new(ASSETS_MANIFEST)).map(drop)
        }
        _ => Err("usage: trinkhallen-importer <data | assets <dir>>".into()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
