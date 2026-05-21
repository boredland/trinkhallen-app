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
 *   dist/static/data/<slug>.geojson    — verbatim per-region FeatureCollection
 *   dist/static/data/_manifest.json    — array of { slug, prefix, bbox, count }
 *   dist/static/data/_summary.geojson  — one Point per region (bbox center)
 *
 * The map client reads _summary.geojson at low zoom and the per-region files at
 * high zoom, intersecting the viewport with manifest bboxes to pick which
 * files to fetch.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
  const summaryFeatures: Feature[] = [];
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

    const [w, s, e, n] = region.bbox;
    summaryFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [(w + e) / 2, (s + n) / 2] },
      properties: { slug: region.slug, count: features.length, bbox: region.bbox },
    });

    for (const f of features) {
      const id = (f.properties as { id?: string; kind?: string }).id;
      const kind = (f.properties as { kind?: string }).kind;
      if (!id || kind === "vending_machine") continue;
      const updated = (f.properties as { updated?: string }).updated;
      sitemapEntries.push({ id, lastmod: updated ?? null });
    }

    console.log(`  ${region.slug}: ${features.length} features`);
  }

  writeFileSync(`${OUT_DIR}/_manifest.json`, JSON.stringify({ regions: manifest }));
  writeFileSync(
    `${OUT_DIR}/_summary.geojson`,
    JSON.stringify({ type: "FeatureCollection", features: summaryFeatures }),
  );

  // ── sitemap.xml ───────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const base = "https://trinkhallen.app";
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${base}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq></url>`,
    `  <url><loc>${base}/about</loc><lastmod>${today}</lastmod></url>`,
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
