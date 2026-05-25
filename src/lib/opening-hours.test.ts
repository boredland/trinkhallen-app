import { describe, expect, it } from "bun:test";
import { computeStatus, kioskLocation } from "./opening-hours";

const FRANKFURT = { region: "frankfurt", lat: 50.11, lng: 8.68 };

// Tag der Deutschen Einheit — national German bank holiday, Saturday in 2026.
const PH_NOON = new Date("2026-10-03T12:00:00Z");
// Plain Saturday a week earlier — same weekday, NOT a holiday.
const NON_PH_NOON = new Date("2026-09-26T12:00:00Z");

describe("computeStatus with PH rules", () => {
  it("treats `PH off` as closed on a Bundesland holiday when location is supplied", () => {
    const status = computeStatus("Mo-Sa 06:00-22:00; PH off", PH_NOON, kioskLocation(FRANKFURT));
    expect(status.kind).toBe("closed");
  });

  it("treats `PH off` as open on a non-holiday Saturday with location", () => {
    const status = computeStatus(
      "Mo-Sa 06:00-22:00; PH off",
      NON_PH_NOON,
      kioskLocation(FRANKFURT),
    );
    expect(status.kind).toBe("open");
  });

  it("mis-evaluates without a location — documents why callers must pass one", () => {
    // Without country/state context the library can't resolve which days
    // are PH, so it treats `PH off` as "always matches off" rather than
    // "matches off only on PH". This was the bug the location-aware
    // callers fix; the assertion locks the broken-without-location
    // behaviour in so we notice if the upstream lib changes.
    const status = computeStatus("Mo-Sa 06:00-22:00; PH off", PH_NOON);
    expect(status.kind).toBe("closed");
  });
});

describe("kioskLocation", () => {
  it("returns full state name for a known region", () => {
    expect(kioskLocation(FRANKFURT)?.state).toBe("Hessen");
  });

  it("returns undefined for an unknown region slug", () => {
    expect(kioskLocation({ region: "atlantis", lat: 0, lng: 0 })).toBeUndefined();
  });
});
