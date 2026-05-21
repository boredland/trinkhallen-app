/**
 * Build-time data import.
 *
 * Pulls the trinkhallen-data repo and lays its GeoJSON files into
 * `dist/static/data/` so the Worker can serve them as static assets
 * instead of round-tripping through D1.
 *
 * Sources, in order:
 *   - TRINKHALLEN_DATA_PATH env var → use that local checkout (dev loop)
 *   - else: shallow-clone boredland/trinkhallen-data into .tmp/ (CI)
 *
 * Emits:
 *   dist/static/data/<slug>.geojson         — verbatim per-region FeatureCollection
 *   dist/static/data/_manifest.json         — array of { slug, prefix, bbox, count }
 *   dist/static/data/_summary_z{5..8}.geojson — supercluster snapshot per zoom band
 *
 * The map client picks the right _summary_z<z>.geojson for the current zoom
 * (one layer per integer zoom in [5, 9)) and switches to the per-region files
 * at and above DETAIL_ZOOM.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Supercluster from "supercluster";
import YAML from "yaml";

const REPO_URL = "https://github.com/boredland/trinkhallen-data.git";
const OUT_DIR = resolve("dist/static/data");
const TMP_DIR = resolve(".tmp/trinkhallen-data");

interface Region {
  slug: string;
  path: string;
  prefix: string;
  iso3166_2: string;
  admin_level: number;
  bbox: [number, number, number, number];
}

interface Feature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

function resolveSourceDir(): string {
  const override = process.env["TRINKHALLEN_DATA_PATH"];
  if (override) {
    const abs = resolve(override);
    if (!existsSync(`${abs}/regions.yml`)) {
      throw new Error(
        `TRINKHALLEN_DATA_PATH=${abs} is not a trinkhallen-data checkout (no regions.yml)`,
      );
    }
    return abs;
  }
  mkdirSync(resolve(".tmp"), { recursive: true });
  if (existsSync(`${TMP_DIR}/.git`)) {
    console.log(`  refreshing existing clone at ${TMP_DIR}`);
    execFileSync("git", ["-C", TMP_DIR, "fetch", "--depth=1", "origin", "main"], {
      stdio: "inherit",
    });
    execFileSync("git", ["-C", TMP_DIR, "reset", "--hard", "origin/main"], { stdio: "inherit" });
  } else {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
    console.log(`  cloning ${REPO_URL} → ${TMP_DIR}`);
    execFileSync("git", ["clone", "--depth=1", REPO_URL, TMP_DIR], { stdio: "inherit" });
  }
  return TMP_DIR;
}

function loadRegions(src: string): Region[] {
  const txt = readFileSync(`${src}/regions.yml`, "utf8");
  const doc = YAML.parse(txt) as { regions: Region[] };
  return doc.regions;
}

function main(): void {
  console.log("Importing trinkhallen-data…");
  const src = resolveSourceDir();
  const regions = loadRegions(src);

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const manifest: Array<{ slug: string; prefix: string; bbox: Region["bbox"]; count: number }> = [];
  // Every non-vending kiosk across all regions, used to feed supercluster for
  // the low-zoom overview snapshots.
  const allOverviewFeatures: Feature[] = [];
  // (id, lastmod-or-null) pairs collected for the build-time sitemap.
  const sitemapEntries: Array<{ id: string; lastmod: string | null }> = [];

  for (const region of regions) {
    const inputPath = resolve(src, region.path);
    if (!existsSync(inputPath)) {
      console.log(`  ${region.slug}: skipped (no data file at ${region.path})`);
      continue;
    }
    const collection = JSON.parse(readFileSync(inputPath, "utf8")) as FeatureCollection;
    const features = collection.features ?? [];
    writeFileSync(`${OUT_DIR}/${region.slug}.geojson`, JSON.stringify(collection));
    manifest.push({
      slug: region.slug,
      prefix: region.prefix,
      bbox: region.bbox,
      count: features.length,
    });

    for (const f of features) {
      const props = f.properties as { id?: string; kind?: string; updated?: string };
      if (props.kind === "vending_machine") continue;
      allOverviewFeatures.push(f);
      if (!props.id) continue;
      sitemapEntries.push({ id: props.id, lastmod: props.updated ?? null });
    }

    console.log(`  ${region.slug}: ${features.length} features`);
  }

  writeFileSync(`${OUT_DIR}/_manifest.json`, JSON.stringify({ regions: manifest }));

  // ── per-zoom overview snapshots ───────────────────────────────────────────
  // One supercluster index over every kiosk; getClusters(world, z) gives us
  // the cluster set as MapLibre would see it at integer zoom z. We emit one
  // file per integer zoom in [5, DETAIL_ZOOM) so the map can pick the right
  // resolution per layer band instead of using a flat per-region centroid.
  const SUMMARY_ZOOMS = [5, 6, 7, 8] as const;
  const cluster = new Supercluster({
    minZoom: SUMMARY_ZOOMS[0],
    maxZoom: SUMMARY_ZOOMS[SUMMARY_ZOOMS.length - 1]!,
    radius: 60,
  }).load(allOverviewFeatures as unknown as GeoJSON.Feature<GeoJSON.Point>[]);

  const WORLD: [number, number, number, number] = [-180, -85, 180, 85];
  for (const z of SUMMARY_ZOOMS) {
    const clusters = cluster.getClusters(WORLD, z);
    // The summary layer only renders count bubbles — drop per-kiosk metadata so
    // every feature is uniform `{point_count, point_count_abbreviated}`, and
    // singletons stay light.
    const slim = clusters.map((f) => ({
      type: "Feature" as const,
      geometry: f.geometry,
      properties: (() => {
        const props = f.properties as { point_count?: number; point_count_abbreviated?: string };
        const count = props.point_count ?? 1;
        return {
          point_count: count,
          point_count_abbreviated: props.point_count_abbreviated ?? String(count),
        };
      })(),
    }));
    writeFileSync(
      `${OUT_DIR}/_summary_z${z}.geojson`,
      JSON.stringify({ type: "FeatureCollection", features: slim }),
    );
    console.log(`  _summary_z${z}.geojson: ${slim.length} clusters`);
  }

  // ── sitemap.xml ───────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const base = "https://trinkhallen.app";
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${base}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq></url>`,
    `  <url><loc>${base}/about</loc><lastmod>${today}</lastmod></url>`,
    // Per-city directory pages (one per region in the manifest).
    ...manifest.map(
      (r) =>
        `  <url><loc>${base}/stadt/${r.slug}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq></url>`,
    ),
    ...sitemapEntries.map(
      ({ id, lastmod }) =>
        `  <url><loc>${base}/k/${id}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`,
    ),
    "</urlset>",
  ].join("\n");
  writeFileSync(resolve("dist/static/sitemap.xml"), xml);

  const total = manifest.reduce((n, r) => n + r.count, 0);
  console.log(`Done. ${manifest.length} regions, ${total} features → ${OUT_DIR}`);
}

main();
