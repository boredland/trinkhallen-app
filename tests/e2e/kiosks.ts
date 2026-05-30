/**
 * Kiosk-data helpers for e2e tests.
 *
 * Tests stay data-agnostic: they don't hard-code a kiosk id (which would
 * couple them to either the committed fixture OR a dev's real trinkhallen-data
 * build). Instead they pull live kiosks from /api/kiosks and pick one at
 * runtime, so the same assertions pass against the fixture in CI and the full
 * dataset locally.
 */

import type { Page } from "@playwright/test";

/** Frankfurt-area box. Both the fixture region and the real dataset put
 *  kiosks here, so a query against it returns rows either way. */
export const FRANKFURT_BBOX = "8.4,50.0,8.9,50.3";

export interface KioskFixture {
  id: string;
  name: string;
  lat: number;
  lng: number;
  hasHours: boolean;
}

export async function fetchKiosks(page: Page, bbox = FRANKFURT_BBOX): Promise<KioskFixture[]> {
  const res = await page.request.get(`/api/kiosks?bbox=${bbox}`);
  if (!res.ok()) throw new Error(`e2e: /api/kiosks → HTTP ${res.status()}`);
  const fc = (await res.json()) as {
    features?: Array<{
      geometry: { coordinates: [number, number] };
      properties: { id: string; name: string; hours?: { raw?: string } };
    }>;
  };
  return (fc.features ?? []).map((f) => ({
    id: f.properties.id,
    name: f.properties.name,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    hasHours: !!f.properties.hours?.raw,
  }));
}

/** A kiosk that carries opening hours — needed for the check-in → signal flow,
 *  whose confirm/dispute block only renders for kiosks with a settled value. */
export async function firstKioskWithHours(page: Page): Promise<KioskFixture> {
  const kiosks = await fetchKiosks(page);
  const hit = kiosks.find((k) => k.hasHours) ?? kiosks[0];
  if (!hit)
    throw new Error("e2e: /api/kiosks returned no kiosks — is the dataset/fixture present?");
  return hit;
}
