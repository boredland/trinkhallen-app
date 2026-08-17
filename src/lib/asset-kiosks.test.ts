import { describe, expect, it } from "bun:test";
import type { Env } from "../env";
import { getKioskById, kiosksByRegion, queryKiosksInBbox } from "./asset-kiosks";

// Module-scope caches in asset-kiosks.ts persist for the test process lifetime.
// Distinct region slugs are used per test case to avoid cross-test cache pollution.

const FIXTURES: Record<string, unknown> = {
  "/data/_manifest.json": {
    regions: [
      { slug: "region-a", prefix: "ra", bbox: [8.0, 50.0, 9.0, 51.0], count: 2 },
      { slug: "region-b", prefix: "rb", bbox: [10.0, 50.0, 11.0, 51.0], count: 2 },
      { slug: "region-c", prefix: "rc", bbox: [12.0, 50.0, 13.0, 51.0], count: 2 },
      { slug: "region-d", prefix: "rd", bbox: [14.0, 50.0, 15.0, 51.0], count: 3 },
    ],
  },
  "/data/region-a.geojson": {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [8.5, 50.5] },
        properties: {
          id: "tk_ra_001",
          name: "Kiosk Alpha",
          address: { street: "Hauptstr.", city: "Teststadt" },
          tags: ["wc"],
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [8.6, 50.6] },
        properties: {
          id: "tk_ra_002",
          name: "Kiosk Beta",
        },
      },
    ],
  },
  "/data/region-b.geojson": {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [10.5, 50.5] },
        properties: {
          id: "tk_rb_001",
          name: "Kiosk B1",
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [10.6, 50.6] },
        properties: {
          id: "tk_rb_002",
          name: "Kiosk B2",
        },
      },
    ],
  },
  "/data/region-c.geojson": {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [12.5, 50.5] },
        properties: {
          id: "tk_rc_001",
          name: "Regular Kiosk C",
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [12.6, 50.6] },
        properties: {
          id: "tk_rc_002",
          name: "Automat C",
          kind: "vending_machine",
        },
      },
    ],
  },
  "/data/region-d.geojson": {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [14.5, 50.5] },
        properties: {
          id: "tk_rd_001",
          name: "Inside Kiosk",
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [14.55, 50.55] },
        properties: {
          id: "tk_rd_002",
          name: "Inside Vending",
          kind: "vending_machine",
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [14.9, 50.9] },
        properties: {
          id: "tk_rd_003",
          name: "Outside Kiosk",
        },
      },
    ],
  },
};

function createStubEnv() {
  const fetchCounts = new Map<string, number>();

  const env = {
    ASSETS: {
      fetch: (input: string | URL | Request) => {
        const urlStr =
          typeof input === "string" ? input : "url" in input ? input.url : input.toString();
        const url = new URL(urlStr);
        const path = url.pathname;
        fetchCounts.set(path, (fetchCounts.get(path) ?? 0) + 1);

        const data = FIXTURES[path];
        if (!data) {
          return Promise.resolve(new Response("Not found", { status: 404 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    },
  } as unknown as Env;

  return { env, fetchCounts };
}

describe("asset-kiosks", () => {
  it("getKioskById returns the matching record for a known id", async () => {
    const { env } = createStubEnv();
    const kiosk = await getKioskById(env, "tk_ra_001");
    expect(kiosk).not.toBeNull();
    expect(kiosk?.id).toBe("tk_ra_001");
    expect(kiosk?.name).toBe("Kiosk Alpha");
    expect(kiosk?.region).toBe("region-a");
    expect(kiosk?.address?.street).toBe("Hauptstr.");
  });

  it("two calls to kiosksByRegion for the same slug fetch /data/<slug>.geojson exactly once", async () => {
    const { env, fetchCounts } = createStubEnv();
    const first = await kiosksByRegion(env, "region-b");
    const second = await kiosksByRegion(env, "region-b");

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first[0]!.id).toBe("tk_rb_001");
    expect(second[0]!.id).toBe("tk_rb_001");
    expect(fetchCounts.get("/data/region-b.geojson")).toBe(1);
  });

  it("kiosksByRegion filters out kind: 'vending_machine' features", async () => {
    const { env } = createStubEnv();
    const kiosks = await kiosksByRegion(env, "region-c");
    expect(kiosks).toHaveLength(1);
    expect(kiosks[0]!.id).toBe("tk_rc_001");
    expect(kiosks[0]!.kind).toBe("kiosk");
  });

  it("getKioskById returns null for an id whose prefix is not in the manifest", async () => {
    const { env } = createStubEnv();
    const kiosk = await getKioskById(env, "tk_unknown_001");
    expect(kiosk).toBeNull();

    const nonPrefixed = await getKioskById(env, "invalid_format_id");
    expect(nonPrefixed).toBeNull();
  });

  it("queryKiosksInBbox returns only features inside the bbox and skips vending", async () => {
    const { env } = createStubEnv();
    const queryBbox = { west: 14.4, south: 50.4, east: 14.6, north: 50.6 };
    const results = await queryKiosksInBbox(env, queryBbox);

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("tk_rd_001");
    expect(results[0]!.name).toBe("Inside Kiosk");
  });
});
