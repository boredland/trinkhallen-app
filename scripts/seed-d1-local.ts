/**
 * Seed the local D1 database from the trinkhallen-data repo.
 *
 * Bypasses the /api/sync webhook handler (which requires a real GitHub push
 * payload). For dev only.
 *
 * Usage: pnpm tsx scripts/seed-d1-local.ts [../trinkhallen-data]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const DATA_REPO = resolve(process.argv[2] ?? "../trinkhallen-data");
const TMP_DIR = resolve(".tmp");
const DB_NAME = "trinkhallen-prod";

interface Feature {
  geometry: { coordinates: [number, number] };
  properties: {
    id: string;
    name: string;
    description?: string;
    address: Record<string, string>;
    hours?: { raw: string };
    tags?: string[];
    payment?: Record<string, string>;
    sources?: Array<{ type: string; id: string; version?: number }>;
  };
}

function escapeSql(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return v.toString();
  return `'${v.replace(/'/g, "''")}'`;
}

function findGeojsonFiles(root: string): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const p = `${dir}/${entry}`;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (entry.endsWith(".geojson")) out.push(p);
    }
  })(`${root}/data`);
  return out;
}

function regionFromPath(path: string): string {
  // .../data/de/hessen/frankfurt.geojson → de/hessen/frankfurt
  const m = path.match(/data\/(.+)\.geojson$/);
  if (!m || !m[1]) throw new Error(`bad data path: ${path}`);
  return m[1];
}

function buildSql(region: string, features: Feature[]): string[] {
  const now = Math.floor(Date.now() / 1000);
  const lines: string[] = [`-- region: ${region} (${features.length} features)`];

  // Truncate region first so re-seeding is idempotent.
  lines.push(`DELETE FROM kiosks WHERE region = ${escapeSql(region)};`);

  for (const f of features) {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;

    const cols = [
      escapeSql(p.id),
      escapeSql(region),
      escapeSql(p.name),
      escapeSql(p.description ?? null),
      escapeSql(JSON.stringify(p.address)),
      escapeSql(p.hours?.raw ?? null),
      escapeSql(JSON.stringify(p.tags ?? [])),
      escapeSql(p.payment ? JSON.stringify(p.payment) : null),
      lng,
      lat,
      escapeSql(p.sources ? JSON.stringify(p.sources) : null),
      now,
    ];
    lines.push(
      `INSERT OR REPLACE INTO kiosks (id, region, name, description, address_json, hours_raw, tags_json, payment_json, lng, lat, sources_json, updated_at) VALUES (${cols.join(", ")});`,
    );
  }

  // Chunk every 1000 features for wrangler d1 execute's payload limits.
  const chunkSize = 1001;
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    chunks.push(lines.slice(i, i + chunkSize).join("\n"));
  }
  return chunks;
}

function main(): void {
  mkdirSync(TMP_DIR, { recursive: true });
  const files = findGeojsonFiles(DATA_REPO);
  console.log(`Seeding ${files.length} region file(s) from ${DATA_REPO}`);

  let chunkIdx = 0;
  for (const file of files) {
    const region = regionFromPath(file);
    const collection = JSON.parse(readFileSync(file, "utf8")) as { features: Feature[] };
    console.log(`  ${region}: ${collection.features.length} features`);
    const chunks = buildSql(region, collection.features);

    for (const sql of chunks) {
      const path = `${TMP_DIR}/seed-${String(chunkIdx).padStart(4, "0")}.sql`;
      writeFileSync(path, sql);
      console.log(`    applying ${relative(process.cwd(), path)} (${sql.split("\n").length} stmts)`);
      execFileSync(
        "pnpm",
        ["wrangler", "d1", "execute", DB_NAME, "--local", `--file=${path}`],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      chunkIdx++;
    }
  }
  console.log(`Done. Applied ${chunkIdx} chunk(s).`);
}

main();
