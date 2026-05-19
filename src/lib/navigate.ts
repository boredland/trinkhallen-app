/**
 * Build platform-appropriate navigation URLs for a kiosk's coordinates.
 *
 * We always expose three options in the UI; the *primary* CTA picks one based
 * on User-Agent so iOS users get Apple Maps, Android users get the geo: URI
 * (which the launcher resolves to the user's default maps app), and desktop
 * gets Google Maps web. The full menu stays one tap away.
 */

export interface NavigateTargets {
  /** The CTA the UI should use as default; one of `apple` / `geo` / `google`. */
  primary: NavigateOption;
  apple: NavigateOption;
  geo: NavigateOption;
  google: NavigateOption;
}

export interface NavigateOption {
  href: string;
  label: string;
}

export function buildNavigateTargets(opts: {
  name: string;
  lat: number;
  lng: number;
  userAgent?: string | null;
}): NavigateTargets {
  const { name, lat, lng } = opts;
  const ua = (opts.userAgent ?? "").toLowerCase();

  const q = `${lat},${lng}`;
  const encodedName = encodeURIComponent(name);

  const apple: NavigateOption = {
    href: `maps://?daddr=${q}&q=${encodedName}`,
    label: "Apple Maps",
  };
  const geo: NavigateOption = {
    // The label form (lat,lng(name)) is widely supported by Android launchers.
    href: `geo:${q}?q=${q}(${encodedName})`,
    label: "Google Maps",
  };
  const google: NavigateOption = {
    href: `https://www.google.com/maps/dir/?api=1&destination=${q}&destination_place_id=${encodedName}`,
    label: "Google Maps (Web)",
  };

  const primary = pickPrimary(ua, { apple, geo, google });
  return { primary, apple, geo, google };
}

function pickPrimary(
  ua: string,
  opts: { apple: NavigateOption; geo: NavigateOption; google: NavigateOption },
): NavigateOption {
  if (/iphone|ipad|ipod/.test(ua)) return opts.apple;
  if (/android/.test(ua)) return opts.geo;
  return opts.google;
}
