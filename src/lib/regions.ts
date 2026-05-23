/**
 * Mirror of trinkhallen-data/regions.yml, embedded in the Worker so we can
 * resolve a kiosk's region slug → target GeoJSON file path when approving a
 * report or submission.
 *
 * Keep in sync with the data repo. The build pipeline doesn't auto-generate
 * this yet; the asset manifest (`/data/_manifest.json`) carries slug/prefix
 * /bbox/count but not `path`, which is what moderation needs to open a PR
 * at the right file. Worth promoting to build-time codegen once it grows.
 */

export interface Region {
  slug: string;
  /** Path relative to repo root, e.g. data/de/hessen/frankfurt.geojson */
  path: string;
  /** ID prefix used when minting new feature ids, e.g. "fr" → tk_fr_xxxx */
  prefix: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
}

export const REGIONS: Region[] = [
  {
    slug: "frankfurt",
    path: "data/de/hessen/frankfurt.geojson",
    prefix: "fr",
    bbox: [7.9, 49.84, 9.48, 50.61],
  },
  {
    slug: "ruhr",
    path: "data/de/nordrhein-westfalen/ruhr.geojson",
    prefix: "ru",
    bbox: [6.59, 51.23, 7.85, 51.98],
  },
  {
    slug: "koeln",
    path: "data/de/nordrhein-westfalen/koeln.geojson",
    prefix: "k",
    bbox: [6.69, 50.62, 7.66, 51.09],
  },
  {
    slug: "duesseldorf",
    path: "data/de/nordrhein-westfalen/duesseldorf.geojson",
    prefix: "d",
    bbox: [6.38, 50.99, 7.17, 51.48],
  },
  {
    slug: "aachen",
    path: "data/de/nordrhein-westfalen/aachen.geojson",
    prefix: "ac",
    bbox: [6.06, 50.73, 6.18, 50.8],
  },
  {
    slug: "bielefeld",
    path: "data/de/nordrhein-westfalen/bielefeld.geojson",
    prefix: "bi",
    bbox: [8.01, 51.7, 8.82, 52.3],
  },
  {
    slug: "berlin",
    path: "data/de/berlin/berlin.geojson",
    prefix: "b",
    bbox: [13.01, 52.37, 13.52, 52.59],
  },
  {
    slug: "hamburg",
    path: "data/de/hamburg/hamburg.geojson",
    prefix: "hh",
    bbox: [9.85, 53.43, 10.25, 53.67],
  },
  {
    slug: "muenchen",
    path: "data/de/bayern/muenchen.geojson",
    prefix: "m",
    bbox: [10.87, 47.71, 11.88, 48.38],
  },
  {
    slug: "nuernberg",
    path: "data/de/bayern/nuernberg.geojson",
    prefix: "n",
    bbox: [10.87, 49.42, 11.22, 49.93],
  },
  {
    slug: "stuttgart",
    path: "data/de/baden-wuerttemberg/stuttgart.geojson",
    prefix: "s",
    bbox: [8.71, 48.6, 9.85, 49.17],
  },
  {
    slug: "karlsruhe",
    path: "data/de/baden-wuerttemberg/karlsruhe.geojson",
    prefix: "ka",
    bbox: [8.22, 48.74, 8.73, 49.15],
  },
  {
    slug: "mannheim",
    path: "data/de/baden-wuerttemberg/mannheim.geojson",
    prefix: "ma",
    bbox: [7.75, 49.26, 9.02, 49.7],
  },
  {
    slug: "freiburg",
    path: "data/de/baden-wuerttemberg/freiburg.geojson",
    prefix: "fr-bw",
    bbox: [7.55, 47.45, 8.56, 48.36],
  },
  {
    slug: "hannover",
    path: "data/de/niedersachsen/hannover.geojson",
    prefix: "h",
    bbox: [9.62, 52.24, 10.55, 52.45],
  },
  {
    slug: "leipzig",
    path: "data/de/sachsen/leipzig.geojson",
    prefix: "l",
    bbox: [12.31, 51.29, 12.44, 51.38],
  },
  {
    slug: "dresden",
    path: "data/de/sachsen/dresden.geojson",
    prefix: "dd",
    bbox: [13.68, 51.02, 13.83, 51.09],
  },
  {
    slug: "halle",
    path: "data/de/sachsen-anhalt/halle.geojson",
    prefix: "hal",
    bbox: [11.28, 51.45, 12, 51.52],
  },
  {
    slug: "bremen",
    path: "data/de/bremen/bremen.geojson",
    prefix: "hb",
    bbox: [8.08, 53.05, 8.86, 53.39],
  },
  {
    slug: "saarbruecken",
    path: "data/de/saarland/saarbruecken.geojson",
    prefix: "sb",
    bbox: [6.95, 49.17, 7.63, 49.26],
  },
  {
    slug: "kiel",
    path: "data/de/schleswig-holstein/kiel.geojson",
    prefix: "ki",
    bbox: [10.1, 54.29, 10.22, 54.42],
  },
  {
    slug: "rostock",
    path: "data/de/mecklenburg-vorpommern/rostock.geojson",
    prefix: "ro",
    bbox: [12.12, 54.07, 12.16, 54.11],
  },
  {
    slug: "mainz",
    path: "data/de/rheinland-pfalz/mainz.geojson",
    prefix: "mz",
    bbox: [7.85, 49.85, 8.55, 50.15],
  },
  {
    slug: "erfurt",
    path: "data/de/thueringen/erfurt.geojson",
    prefix: "ef",
    bbox: [10.85, 50.85, 11.65, 51.1],
  },
  {
    slug: "potsdam",
    path: "data/de/brandenburg/potsdam.geojson",
    prefix: "p",
    bbox: [12.85, 52.3, 13.2, 52.5],
  },
  {
    slug: "magdeburg",
    path: "data/de/sachsen-anhalt/magdeburg.geojson",
    prefix: "md",
    bbox: [11.5, 52, 11.8, 52.25],
  },
  {
    slug: "chemnitz",
    path: "data/de/sachsen/chemnitz.geojson",
    prefix: "c",
    bbox: [12.75, 50.7, 13.1, 50.95],
  },
  {
    slug: "augsburg",
    path: "data/de/bayern/augsburg.geojson",
    prefix: "a",
    bbox: [10.8, 48.25, 11.05, 48.45],
  },
  {
    slug: "muenster",
    path: "data/de/nordrhein-westfalen/muenster.geojson",
    prefix: "ms",
    bbox: [7.45, 51.85, 7.85, 52.1],
  },
  {
    slug: "osnabrueck",
    path: "data/de/niedersachsen/osnabrueck.geojson",
    prefix: "os",
    bbox: [7.9, 52.15, 8.2, 52.4],
  },
  {
    slug: "kassel",
    path: "data/de/hessen/kassel.geojson",
    prefix: "ks",
    bbox: [9.3, 51.2, 9.65, 51.45],
  },
  {
    slug: "goettingen",
    path: "data/de/niedersachsen/goettingen.geojson",
    prefix: "go",
    bbox: [9.8, 51.45, 10.1, 51.65],
  },
  {
    slug: "hildesheim",
    path: "data/de/niedersachsen/hildesheim.geojson",
    prefix: "hi",
    bbox: [9.8, 52.05, 10.1, 52.25],
  },
  {
    slug: "salzgitter",
    path: "data/de/niedersachsen/salzgitter.geojson",
    prefix: "sz",
    bbox: [10.2, 52.05, 10.5, 52.25],
  },
  {
    slug: "wolfsburg",
    path: "data/de/niedersachsen/wolfsburg.geojson",
    prefix: "wob",
    bbox: [10.65, 52.35, 10.95, 52.55],
  },
  {
    slug: "koblenz",
    path: "data/de/rheinland-pfalz/koblenz.geojson",
    prefix: "ko",
    bbox: [7.45, 50.25, 7.75, 50.45],
  },
  {
    slug: "trier",
    path: "data/de/rheinland-pfalz/trier.geojson",
    prefix: "tr",
    bbox: [6.5, 49.65, 6.8, 49.85],
  },
  {
    slug: "regensburg",
    path: "data/de/bayern/regensburg.geojson",
    prefix: "rg",
    bbox: [11.95, 48.9, 12.25, 49.1],
  },
  {
    slug: "ingolstadt",
    path: "data/de/bayern/ingolstadt.geojson",
    prefix: "in",
    bbox: [11.3, 48.65, 11.6, 48.85],
  },
  {
    slug: "wuerzburg",
    path: "data/de/bayern/wuerzburg.geojson",
    prefix: "wu",
    bbox: [9.8, 49.7, 10.1, 49.9],
  },
  {
    slug: "ulm",
    path: "data/de/baden-wuerttemberg/ulm.geojson",
    prefix: "ul",
    bbox: [9.85, 48.3, 10.15, 48.5],
  },
  {
    slug: "reutlingen",
    path: "data/de/baden-wuerttemberg/reutlingen.geojson",
    prefix: "rt",
    bbox: [9.05, 48.4, 9.35, 48.58],
  },
  {
    slug: "remscheid",
    path: "data/de/nordrhein-westfalen/remscheid.geojson",
    prefix: "rs",
    bbox: [7.05, 51.1, 7.3, 51.27],
  },
  {
    slug: "siegen",
    path: "data/de/nordrhein-westfalen/siegen.geojson",
    prefix: "si",
    bbox: [7.9, 50.78, 8.2, 50.97],
  },
  {
    slug: "bremerhaven",
    path: "data/de/bremen/bremerhaven.geojson",
    prefix: "brv",
    bbox: [8.45, 53.45, 8.75, 53.65],
  },
  {
    slug: "luebeck",
    path: "data/de/schleswig-holstein/luebeck.geojson",
    prefix: "lu",
    bbox: [10.55, 53.78, 10.85, 53.97],
  },
  {
    slug: "cottbus",
    path: "data/de/brandenburg/cottbus.geojson",
    prefix: "cb",
    bbox: [14.15, 51.66, 14.5, 51.86],
  },
];

export function resolveRegionByCoords(lng: number, lat: number): Region | null {
  return (
    REGIONS.find(
      (r) => lng >= r.bbox[0] && lng <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3],
    ) ?? null
  );
}

export function resolveRegionByPath(path: string): Region | null {
  return REGIONS.find((r) => r.path === path) ?? null;
}

export function resolveRegionBySlug(slug: string): Region | null {
  return REGIONS.find((r) => r.slug === slug) ?? null;
}
