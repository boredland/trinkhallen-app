//! `data` step: trinkhallen-data checkout → `dist/static/data/*`, summaries,
//! `sitemap.xml` and the core regions table.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use trinkhallen_core::hours::flatten_week;
use trinkhallen_core::kind::classify_kind;

use crate::json::Json;
use crate::regions::{self, Region};
use crate::sitemap;
use crate::supercluster::{Abbreviated, Item, Options, Supercluster, abbreviate};

const REPO_URL: &str = "https://github.com/boredland/trinkhallen-data.git";
const SUMMARY_ZOOMS: [usize; 4] = [5, 6, 7, 8];

#[derive(Debug, Default, PartialEq)]
pub struct Stats {
    pub regions: usize,
    pub features: usize,
    pub visible_total: usize,
    pub flattened_hours: usize,
    pub library_hours: usize,
    pub summary_clusters: Vec<(usize, usize)>,
    pub sitemap_urls: usize,
}

/// `TRINKHALLEN_DATA_PATH` wins (dev loop); otherwise a shallow clone under
/// `.tmp/trinkhallen-data`, refreshed in place when it already exists.
pub fn resolve_source_dir() -> Result<PathBuf, String> {
    if let Some(override_path) = std::env::var_os("TRINKHALLEN_DATA_PATH").filter(|v| !v.is_empty())
    {
        let abs = std::path::absolute(&override_path).map_err(|e| e.to_string())?;
        if !abs.join("regions.yml").exists() {
            return Err(format!(
                "TRINKHALLEN_DATA_PATH={} is not a trinkhallen-data checkout (no regions.yml)",
                abs.display()
            ));
        }
        return Ok(abs);
    }
    let tmp_root = std::path::absolute(".tmp").map_err(|e| e.to_string())?;
    fs::create_dir_all(&tmp_root).map_err(|e| e.to_string())?;
    let clone = tmp_root.join("trinkhallen-data");
    if clone.join(".git").exists() {
        println!("  refreshing existing clone at {}", clone.display());
        git(&[
            "-C",
            path_str(&clone)?,
            "fetch",
            "--depth=1",
            "origin",
            "main",
        ])?;
        git(&["-C", path_str(&clone)?, "reset", "--hard", "origin/main"])?;
    } else {
        if clone.exists() {
            fs::remove_dir_all(&clone).map_err(|e| e.to_string())?;
        }
        println!("  cloning {REPO_URL} → {}", clone.display());
        git(&["clone", "--depth=1", REPO_URL, path_str(&clone)?])?;
    }
    Ok(clone)
}

fn path_str(p: &Path) -> Result<&str, String> {
    p.to_str()
        .ok_or_else(|| format!("non-UTF-8 path {}", p.display()))
}

fn git(args: &[&str]) -> Result<(), String> {
    let status = Command::new("git")
        .args(args)
        .status()
        .map_err(|e| format!("git: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("git {} failed ({status})", args.join(" ")))
    }
}

/// Bake `hours.week` into every feature whose rule can be flattened; returns
/// `(flattened, left_to_the_evaluator)`.
fn bake_weeks(features: &mut [Json]) -> (usize, usize) {
    let (mut flattened, mut library) = (0, 0);
    for f in features {
        let Some(hours) = f.get_mut("properties").and_then(|p| p.get_mut("hours")) else {
            continue;
        };
        let Some(raw) = hours
            .get("raw")
            .and_then(Json::as_str)
            .filter(|r| !r.is_empty())
            .map(str::to_owned)
        else {
            continue;
        };
        match flatten_week(&raw) {
            Some(week) => {
                hours.set("week", Json::Arr(week.into_iter().map(Json::num).collect()));
                flattened += 1;
            }
            None => library += 1,
        }
    }
    (flattened, library)
}

fn bbox_json(bbox: [f64; 4]) -> Json {
    Json::Arr(bbox.into_iter().map(Json::Num).collect())
}

fn write(path: &Path, contents: &str) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| format!("write {}: {e}", path.display()))
}

fn summary_feature(item: Item, points: &[(f64, f64)]) -> Json {
    let (lng, lat, count) = match item {
        Item::Point(i) => (points[i].0, points[i].1, 1),
        Item::Cluster { lng, lat, count } => (lng, lat, count),
    };
    // Singletons never carry a supercluster abbreviation; the published
    // snapshots use `String(count)` there.
    let abbreviated = match item {
        Item::Point(_) => Json::str("1"),
        Item::Cluster { .. } => match abbreviate(count) {
            Abbreviated::Number(n) => Json::num(n),
            Abbreviated::Text(t) => Json::Str(t),
        },
    };
    Json::obj([
        ("type", Json::str("Feature")),
        (
            "geometry",
            Json::obj([
                ("type", Json::str("Point")),
                (
                    "coordinates",
                    Json::Arr(vec![Json::Num(lng), Json::Num(lat)]),
                ),
            ]),
        ),
        (
            "properties",
            Json::obj([
                ("point_count", Json::num(count)),
                ("point_count_abbreviated", abbreviated),
            ]),
        ),
    ])
}

/// Run the whole import. `static_dir` is `dist/static`; `generated_rs` the
/// core regions table. Data files go to `<static_dir>/data`.
pub fn import(
    src: &Path,
    static_dir: &Path,
    generated_rs: &Path,
    today: &str,
) -> Result<Stats, String> {
    let yaml = fs::read_to_string(src.join("regions.yml"))
        .map_err(|e| format!("read regions.yml: {e}"))?;
    let regions = regions::parse(&yaml)?;

    let out_dir = static_dir.join("data");
    if out_dir.exists() {
        fs::remove_dir_all(&out_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let mut stats = Stats::default();
    let mut manifest_regions: Vec<(&Region, usize)> = Vec::new();
    // Every non-vending kiosk with usable coordinates feeds the overview clusters.
    let mut overview: Vec<(f64, f64)> = Vec::new();
    let mut sitemap_kiosks: Vec<(String, Option<String>)> = Vec::new();

    for region in &regions {
        let input = src.join(&region.path);
        if !input.exists() {
            println!(
                "  {}: skipped (no data file at {})",
                region.slug, region.path
            );
            continue;
        }
        let text =
            fs::read_to_string(&input).map_err(|e| format!("read {}: {e}", input.display()))?;
        let mut collection: Json =
            serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", input.display()))?;

        let features: &mut [Json] = match collection.get_mut("features") {
            Some(Json::Arr(items)) => items,
            _ => &mut [],
        };
        let (flattened, library) = bake_weeks(features);
        stats.flattened_hours += flattened;
        stats.library_hours += library;

        for f in features.iter() {
            let props = f.get("properties");
            let name = props.and_then(|p| p.get("name")).and_then(Json::as_str);
            let kind = props.and_then(|p| p.get("kind")).and_then(Json::as_str);
            if classify_kind(name, kind).is_listed() {
                stats.visible_total += 1;
            }
            // The overview and sitemap use the data repo's own flag only; the
            // name heuristic is deliberately not applied there.
            if kind == Some("vending_machine") {
                continue;
            }
            if let Some(Json::Arr(c)) = f.get("geometry").and_then(|g| g.get("coordinates")) {
                if let (Some(Json::Num(lng)), Some(Json::Num(lat))) = (c.first(), c.get(1)) {
                    overview.push((*lng, *lat));
                }
            }
            let Some(id) = props
                .and_then(|p| p.get("id"))
                .and_then(Json::as_str)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let updated = props
                .and_then(|p| p.get("updated"))
                .and_then(Json::as_str)
                .map(str::to_owned);
            sitemap_kiosks.push((id.to_owned(), updated));
        }

        let count = features.len();
        write(
            &out_dir.join(format!("{}.geojson", region.slug)),
            &collection.stringify(),
        )?;
        manifest_regions.push((region, count));
        stats.features += count;
        println!("  {}: {count} features", region.slug);
    }

    // `/about` shows `visibleTotal`; baking it here keeps that page from
    // parsing every region file, and classify_kind matches what the map hides.
    let manifest = Json::obj([
        ("visibleTotal", Json::num(stats.visible_total as f64)),
        (
            "regions",
            Json::Arr(
                manifest_regions
                    .iter()
                    .map(|(r, count)| {
                        Json::obj([
                            ("slug", Json::str(&r.slug)),
                            ("prefix", Json::str(&r.prefix)),
                            ("bbox", bbox_json(r.bbox)),
                            ("count", Json::num(*count as f64)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]);
    write(&out_dir.join("_manifest.json"), &manifest.stringify())?;
    stats.regions = manifest_regions.len();

    let first = SUMMARY_ZOOMS[0];
    let last = SUMMARY_ZOOMS[SUMMARY_ZOOMS.len() - 1];
    let index = Supercluster::load(
        Options {
            min_zoom: first,
            max_zoom: last,
            radius: 60.0,
            ..Options::default()
        },
        &overview,
    );
    for z in SUMMARY_ZOOMS {
        let features: Vec<Json> = index
            .world_clusters(z)
            .into_iter()
            .map(|i| summary_feature(i, &overview))
            .collect();
        let n = features.len();
        let fc = Json::obj([
            ("type", Json::str("FeatureCollection")),
            ("features", Json::Arr(features)),
        ]);
        write(
            &out_dir.join(format!("_summary_z{z}.geojson")),
            &fc.stringify(),
        )?;
        println!("  _summary_z{z}.geojson: {n} clusters");
        stats.summary_clusters.push((z, n));
    }

    let slugs: Vec<&str> = manifest_regions
        .iter()
        .map(|(r, _)| r.slug.as_str())
        .collect();
    let xml = sitemap::render(today, &slugs, &sitemap_kiosks);
    stats.sitemap_urls = xml.matches("<url>").count();
    write(&static_dir.join("sitemap.xml"), &xml)?;

    let generated = regions::render_generated(&regions);
    if fs::read_to_string(generated_rs).ok().as_deref() != Some(generated.as_str()) {
        write(generated_rs, &generated)?;
    }

    let with_hours = stats.flattened_hours + stats.library_hours;
    if with_hours > 0 {
        println!(
            "  opening hours: {}/{with_hours} flattened ({:.1}%), {} need the evaluator at runtime",
            stats.flattened_hours,
            100.0 * stats.flattened_hours as f64 / with_hours as f64,
            stats.library_hours
        );
    }
    println!(
        "Done. {} regions, {} features → {}",
        stats.regions,
        stats.features,
        out_dir.display()
    );
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGIONS_YML: &str = "regions:
  - slug: alpha
    path: data/alpha.geojson
    prefix: al
    bbox: [8.0, 49.0, 9.0, 50.0]
  - slug: ghost
    path: data/missing.geojson
    prefix: gh
    bbox: [1.0, 2.0, 3.0, 4.0]
";

    fn feature(id: &str, name: &str, extra: &str, hours: &str) -> String {
        format!(
            r#"{{"type":"Feature","geometry":{{"type":"Point","coordinates":[8.5,49.5]}},"properties":{{"id":"{id}","name":"{name}","updated":"2026-05-01"{extra}{hours}}}}}"#
        )
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("src/data");
        fs::create_dir_all(&data).unwrap();
        fs::write(dir.path().join("src/regions.yml"), REGIONS_YML).unwrap();
        let features = [
            feature(
                "tk_al_1",
                "Büdchen",
                "",
                r#","hours":{"raw":"Mo-Fr 08:00-20:00","note":"x"}"#,
            ),
            feature("tk_al_2", "Selecta", "", ""),
            feature("tk_al_3", "Automat", r#","kind":"vending_machine""#, ""),
            feature(
                "tk_al_4",
                "Kiosk PH",
                "",
                r#","hours":{"raw":"Mo-Fr 08:00-20:00; PH off"}"#,
            ),
        ];
        fs::write(
            data.join("alpha.geojson"),
            format!(
                r#"{{"type":"FeatureCollection","features":[{}]}}"#,
                features.join(",")
            ),
        )
        .unwrap();
        dir
    }

    #[test]
    fn writes_regions_manifest_summaries_sitemap_and_table() {
        let dir = fixture();
        let out = dir.path().join("dist/static");
        let table = dir.path().join("generated.rs");
        let stats = import(&dir.path().join("src"), &out, &table, "2026-08-23").unwrap();

        // Four features; "Selecta" is a vending machine by name, "Automat" by flag.
        assert_eq!(stats.features, 4);
        assert_eq!(stats.visible_total, 2);
        assert_eq!((stats.flattened_hours, stats.library_hours), (1, 1));
        assert_eq!(
            stats.regions, 1,
            "the region without a data file is skipped"
        );

        let manifest = fs::read_to_string(out.join("data/_manifest.json")).unwrap();
        assert_eq!(
            manifest,
            r#"{"visibleTotal":2,"regions":[{"slug":"alpha","prefix":"al","bbox":[8,49,9,50],"count":4}]}"#
        );

        let alpha = fs::read_to_string(out.join("data/alpha.geojson")).unwrap();
        // 480..1200 on Monday = minutes 480..1200 of the reference week; key order preserved, week appended.
        assert!(alpha.contains(
            r#""hours":{"raw":"Mo-Fr 08:00-20:00","note":"x","week":[480,1200,1920,2640,3360,4080,4800,5520,6240,6960]}"#
        ));
        assert!(!alpha.contains(r#""PH off","week""#));

        // All kiosks share one point → every summary is a single cluster. The
        // name-based "Selecta" stays (flag-only rule); the flagged one is out.
        let z5 = fs::read_to_string(out.join("data/_summary_z5.geojson")).unwrap();
        assert!(
            z5.contains(r#""properties":{"point_count":3,"point_count_abbreviated":3}"#),
            "{z5}"
        );
        assert_eq!(stats.summary_clusters, vec![(5, 1), (6, 1), (7, 1), (8, 1)]);

        let sitemap = fs::read_to_string(out.join("sitemap.xml")).unwrap();
        assert_eq!(stats.sitemap_urls, 2 + 6 + 2 + 3 * 2);
        assert!(
            sitemap.contains(
                "<loc>https://trinkhallen.app/k/tk_al_2</loc><lastmod>2026-05-01</lastmod>"
            )
        );
        assert!(!sitemap.contains("tk_al_3"));

        let generated = fs::read_to_string(&table).unwrap();
        assert!(generated.contains(r#"Region { slug: "ghost", path: "data/missing.geojson", prefix: "gh", bbox: [1.0, 2.0, 3.0, 4.0], role: Role::City }"#));
    }

    #[test]
    fn bad_prefix_fails_before_anything_is_written() {
        let dir = fixture();
        fs::write(
            dir.path().join("src/regions.yml"),
            "regions:\n  - slug: a\n    path: p\n    prefix: A_b\n    bbox: [1, 2, 3, 4]\n",
        )
        .unwrap();
        let out = dir.path().join("dist/static");
        let err = import(
            &dir.path().join("src"),
            &out,
            &dir.path().join("g.rs"),
            "2026-08-23",
        )
        .unwrap_err();
        assert!(err.contains("not [a-z0-9]+"));
        assert!(!out.exists());
    }
}
