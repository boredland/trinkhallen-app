/**
 * Shape used by views and components — produced by lib/asset-kiosks.ts from
 * the static GeoJSON files. Kept here as the canonical record type for any
 * UI code that consumes a "kiosk row".
 */
export interface KioskRecord {
  id: string;
  region: string;
  name: string;
  description?: string;
  address: Record<string, string | undefined>;
  hours?: { raw: string };
  tags: string[];
  payment?: Record<string, "yes" | "no" | "unknown">;
  lng: number;
  lat: number;
  sources?: Array<{ type: string; id: string; version?: number }>;
  updatedAt: number;
}
