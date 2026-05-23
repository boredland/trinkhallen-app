import { describe, expect, it } from "bun:test";
import {
  REGIONS,
  resolveRegionByCoords,
  resolveRegionByPath,
  resolveRegionBySlug,
} from "./regions";

describe("resolveRegionBySlug", () => {
  it("returns the region for a known slug", () => {
    const r = resolveRegionBySlug("frankfurt");
    expect(r?.path).toBe("data/de/hessen/frankfurt.geojson");
    expect(r?.prefix).toBe("fr");
  });

  it("returns null for an unknown slug", () => {
    expect(resolveRegionBySlug("atlantis")).toBeNull();
  });
});

describe("resolveRegionByPath", () => {
  it("returns the region for a known path", () => {
    expect(resolveRegionByPath("data/de/hessen/frankfurt.geojson")?.slug).toBe("frankfurt");
  });
  it("returns null for an unknown path", () => {
    expect(resolveRegionByPath("data/de/atlantis/lost.geojson")).toBeNull();
  });
});

describe("resolveRegionByCoords", () => {
  it("snaps a Frankfurt centre coord into the frankfurt region", () => {
    expect(resolveRegionByCoords(8.68, 50.11)?.slug).toBe("frankfurt");
  });
  it("returns null for coordinates outside every region bbox", () => {
    // Mid-Atlantic.
    expect(resolveRegionByCoords(-30, 30)).toBeNull();
  });
});

describe("REGIONS shape", () => {
  it("every entry has a non-empty slug, path, prefix and a 4-tuple bbox", () => {
    for (const r of REGIONS) {
      expect(r.slug).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(r.path).toMatch(/^data\/de\/[a-z-]+\/[a-z][a-z0-9-]+\.geojson$/);
      expect(r.prefix.length).toBeGreaterThan(0);
      expect(r.bbox).toHaveLength(4);
      // [w, s, e, n] sanity: west < east, south < north, plausible Germany.
      const [w, s, e, n] = r.bbox;
      expect(w).toBeLessThan(e);
      expect(s).toBeLessThan(n);
      expect(w).toBeGreaterThan(5);
      expect(e).toBeLessThan(16);
      expect(s).toBeGreaterThan(47);
      expect(n).toBeLessThan(56);
    }
  });

  it("slugs are unique", () => {
    const seen = new Set(REGIONS.map((r) => r.slug));
    expect(seen.size).toBe(REGIONS.length);
  });

  it("paths are unique", () => {
    const seen = new Set(REGIONS.map((r) => r.path));
    expect(seen.size).toBe(REGIONS.length);
  });
});
