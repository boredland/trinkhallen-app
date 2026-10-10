//! Port of `supercluster` 8 + `kdbush` 4 (the versions the TS importer ran).
//!
//! The summary snapshots must match what the JS library produced, so this
//! mirrors its numeric behaviour instead of using idiomatic structures:
//! KD-tree coordinates are `f32` while the cluster table stays `f64`, the
//! tree is sorted with the same Floyd-Rivest selection, and neighbours are
//! visited in tree order (that order decides float summation order and the
//! output order).

const OFFSET_ZOOM: usize = 2;
const OFFSET_ID: usize = 3;
const OFFSET_NUM: usize = 5;
const STRIDE: usize = 6;

#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub min_zoom: usize,
    pub max_zoom: usize,
    pub radius: f64,
    pub extent: f64,
    pub node_size: usize,
    pub min_points: f64,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            min_zoom: 0,
            max_zoom: 16,
            radius: 40.0,
            extent: 512.0,
            node_size: 64,
            min_points: 2.0,
        }
    }
}

/// One entry of `getClusters`: either an input point (by index) or a cluster.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Item {
    Point(usize),
    Cluster { lng: f64, lat: f64, count: u32 },
}

pub struct Supercluster {
    opts: Options,
    trees: Vec<Option<Tree>>,
}

struct Index {
    ids: Vec<u32>,
    coords: Vec<f32>,
    node_size: i64,
}

struct Tree {
    index: Index,
    data: Vec<f64>,
}

impl Supercluster {
    /// `new Supercluster(opts).load(points)` for `(lng, lat)` points.
    pub fn load(opts: Options, points: &[(f64, f64)]) -> Self {
        let mut data = Vec::with_capacity(points.len() * STRIDE);
        for (i, &(lng, lat)) in points.iter().enumerate() {
            data.extend_from_slice(&[
                fround(lng_x(lng)),
                fround(lat_y(lat)),
                f64::INFINITY,
                i as f64,
                -1.0,
                1.0,
            ]);
        }
        let mut trees: Vec<Option<Tree>> = (0..=opts.max_zoom + 1).map(|_| None).collect();
        let mut prev = Tree::new(data, opts.node_size);
        for z in (opts.min_zoom..=opts.max_zoom).rev() {
            let next = Tree::new(cluster(&mut prev, z, &opts), opts.node_size);
            trees[z + 1] = Some(prev);
            prev = next;
        }
        trees[opts.min_zoom] = Some(prev);
        Supercluster { opts, trees }
    }

    /// `getClusters([-180, -85, 180, 85], zoom)`: the whole-world branch, so no
    /// antimeridian splitting is needed.
    pub fn world_clusters(&self, zoom: usize) -> Vec<Item> {
        let z = zoom.clamp(self.opts.min_zoom, self.opts.max_zoom + 1);
        let Some(tree) = self.trees[z].as_ref() else {
            return Vec::new();
        };
        let ids = tree
            .index
            .range(lng_x(-180.0), lat_y(85.0), lng_x(180.0), lat_y(-85.0));
        ids.into_iter()
            .map(|id| {
                let k = STRIDE * id as usize;
                let count = tree.data[k + OFFSET_NUM];
                if count > 1.0 {
                    Item::Cluster {
                        lng: x_lng(tree.data[k]),
                        lat: y_lat(tree.data[k + 1]),
                        count: count as u32,
                    }
                } else {
                    Item::Point(tree.data[k + OFFSET_ID] as usize)
                }
            })
            .collect()
    }
}

impl Tree {
    fn new(data: Vec<f64>, node_size: usize) -> Tree {
        let n = data.len() / STRIDE;
        let mut ids: Vec<u32> = (0..n as u32).collect();
        let mut coords = Vec::with_capacity(n * 2);
        for i in 0..n {
            coords.push(data[i * STRIDE] as f32);
            coords.push(data[i * STRIDE + 1] as f32);
        }
        let node_size = node_size.clamp(2, 65535) as i64;
        sort(&mut ids, &mut coords, node_size, 0, n as i64 - 1, 0);
        Tree {
            index: Index {
                ids,
                coords,
                node_size,
            },
            data,
        }
    }
}

/// One greedy merge pass (`Supercluster._cluster`).
fn cluster(tree: &mut Tree, zoom: usize, opts: &Options) -> Vec<f64> {
    let zoom_f = zoom as f64;
    let r = opts.radius / (opts.extent * 2f64.powi(zoom as i32));
    let Tree { index, data } = tree;
    let mut next = Vec::new();
    let mut neighbors = Vec::new();

    let mut i = 0;
    while i < data.len() {
        if data[i + OFFSET_ZOOM] <= zoom_f {
            i += STRIDE;
            continue;
        }
        data[i + OFFSET_ZOOM] = zoom_f;

        let (x, y) = (data[i], data[i + 1]);
        index.within(x, y, r, &mut neighbors);

        let origin = data[i + OFFSET_NUM];
        let mut num = origin;
        for &nb in &neighbors {
            let k = nb as usize * STRIDE;
            if data[k + OFFSET_ZOOM] > zoom_f {
                num += data[k + OFFSET_NUM];
            }
        }

        if num > origin && num >= opts.min_points {
            let mut wx = x * origin;
            let mut wy = y * origin;
            for &nb in &neighbors {
                let k = nb as usize * STRIDE;
                if data[k + OFFSET_ZOOM] <= zoom_f {
                    continue;
                }
                data[k + OFFSET_ZOOM] = zoom_f;
                let n2 = data[k + OFFSET_NUM];
                wx += data[k] * n2;
                wy += data[k + 1] * n2;
            }
            // Slot 3 (source index) is only read for singletons; a cluster has none.
            next.extend_from_slice(&[wx / num, wy / num, f64::INFINITY, -1.0, -1.0, num]);
        } else {
            next.extend_from_slice(&data[i..i + STRIDE]);
            if num > 1.0 {
                for &nb in &neighbors {
                    let k = nb as usize * STRIDE;
                    if data[k + OFFSET_ZOOM] <= zoom_f {
                        continue;
                    }
                    data[k + OFFSET_ZOOM] = zoom_f;
                    next.extend_from_slice(&data[k..k + STRIDE]);
                }
            }
        }
        i += STRIDE;
    }
    next
}

impl Index {
    fn sq_dist_to(&self, i: usize, qx: f64, qy: f64) -> f64 {
        let dx = self.coords[2 * i] as f64 - qx;
        let dy = self.coords[2 * i + 1] as f64 - qy;
        dx * dx + dy * dy
    }

    /// `KDBush.within`; results are written to `out` in the library's visit order.
    fn within(&self, qx: f64, qy: f64, r: f64, out: &mut Vec<u32>) {
        out.clear();
        if self.ids.is_empty() {
            return;
        }
        let r2 = r * r;
        let mut stack = vec![(0i64, self.ids.len() as i64 - 1, 0u8)];
        while let Some((left, right, axis)) = stack.pop() {
            if right - left <= self.node_size {
                for i in left..=right {
                    if self.sq_dist_to(i as usize, qx, qy) <= r2 {
                        out.push(self.ids[i as usize]);
                    }
                }
                continue;
            }
            let m = (left + right) >> 1;
            let (x, y) = (
                self.coords[2 * m as usize] as f64,
                self.coords[2 * m as usize + 1] as f64,
            );
            if self.sq_dist_to(m as usize, qx, qy) <= r2 {
                out.push(self.ids[m as usize]);
            }
            let (q, v) = if axis == 0 { (qx, x) } else { (qy, y) };
            if q - r <= v {
                stack.push((left, m - 1, 1 - axis));
            }
            if q + r >= v {
                stack.push((m + 1, right, 1 - axis));
            }
        }
    }

    /// `KDBush.range`.
    fn range(&self, min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Vec<u32> {
        let mut out = Vec::new();
        if self.ids.is_empty() {
            return out;
        }
        let inside = |i: usize| {
            let (x, y) = (self.coords[2 * i] as f64, self.coords[2 * i + 1] as f64);
            x >= min_x && x <= max_x && y >= min_y && y <= max_y
        };
        let mut stack = vec![(0i64, self.ids.len() as i64 - 1, 0u8)];
        while let Some((left, right, axis)) = stack.pop() {
            if right - left <= self.node_size {
                for i in left..=right {
                    if inside(i as usize) {
                        out.push(self.ids[i as usize]);
                    }
                }
                continue;
            }
            let m = (left + right) >> 1;
            let (x, y) = (
                self.coords[2 * m as usize] as f64,
                self.coords[2 * m as usize + 1] as f64,
            );
            if inside(m as usize) {
                out.push(self.ids[m as usize]);
            }
            let (lo, hi, v) = if axis == 0 {
                (min_x, max_x, x)
            } else {
                (min_y, max_y, y)
            };
            if lo <= v {
                stack.push((left, m - 1, 1 - axis));
            }
            if hi >= v {
                stack.push((m + 1, right, 1 - axis));
            }
        }
        out
    }
}

fn sort(ids: &mut [u32], coords: &mut [f32], node_size: i64, left: i64, right: i64, axis: usize) {
    if right - left <= node_size {
        return;
    }
    let m = (left + right) >> 1;
    select(ids, coords, m, left, right, axis);
    sort(ids, coords, node_size, left, m - 1, 1 - axis);
    sort(ids, coords, node_size, m + 1, right, 1 - axis);
}

/// Floyd-Rivest selection, as in kdbush. Out-of-range reads behave like JS
/// `undefined`: every comparison against them is false.
fn select(ids: &mut [u32], coords: &mut [f32], k: i64, mut left: i64, mut right: i64, axis: usize) {
    let at = |coords: &[f32], i: i64| -> f64 {
        if i < 0 {
            return f64::NAN;
        }
        coords
            .get(2 * i as usize + axis)
            .map_or(f64::NAN, |v| *v as f64)
    };
    while right > left {
        if right - left > 600 {
            let n = (right - left + 1) as f64;
            let m = (k - left + 1) as f64;
            let z = n.ln();
            let s = 0.5 * (2.0 * z / 3.0).exp();
            let sign = if m - n / 2.0 < 0.0 { -1.0 } else { 1.0 };
            let sd = 0.5 * (z * s * (n - s) / n).sqrt() * sign;
            let new_left = left.max((k as f64 - m * s / n + sd).floor() as i64);
            let new_right = right.min((k as f64 + (n - m) * s / n + sd).floor() as i64);
            select(ids, coords, k, new_left, new_right, axis);
        }

        let t = at(coords, k);
        let (mut i, mut j) = (left, right);

        swap_item(ids, coords, left, k);
        if at(coords, right) > t {
            swap_item(ids, coords, left, right);
        }

        while i < j {
            swap_item(ids, coords, i, j);
            i += 1;
            j -= 1;
            while at(coords, i) < t {
                i += 1;
            }
            while at(coords, j) > t {
                j -= 1;
            }
        }

        if at(coords, left) == t {
            swap_item(ids, coords, left, j);
        } else {
            j += 1;
            swap_item(ids, coords, j, right);
        }

        if j <= k {
            left = j + 1;
        }
        if k <= j {
            right = j - 1;
        }
    }
}

fn swap_item(ids: &mut [u32], coords: &mut [f32], i: i64, j: i64) {
    let (i, j) = (i as usize, j as usize);
    ids.swap(i, j);
    coords.swap(2 * i, 2 * j);
    coords.swap(2 * i + 1, 2 * j + 1);
}

fn fround(x: f64) -> f64 {
    x as f32 as f64
}

fn lng_x(lng: f64) -> f64 {
    lng / 360.0 + 0.5
}

fn lat_y(lat: f64) -> f64 {
    let sin = (lat * std::f64::consts::PI / 180.0).sin();
    let y = 0.5 - 0.25 * ((1.0 + sin) / (1.0 - sin)).ln() / std::f64::consts::PI;
    y.clamp(0.0, 1.0)
}

fn x_lng(x: f64) -> f64 {
    (x - 0.5) * 360.0
}

fn y_lat(y: f64) -> f64 {
    let y2 = (180.0 - y * 360.0) * std::f64::consts::PI / 180.0;
    360.0 * y2.exp().atan() / std::f64::consts::PI - 90.0
}

/// `point_count_abbreviated` as supercluster formats it: a number below 1000
/// (kept numeric in the JSON, like the JS output), `"1.2k"` / `"12k"` above.
#[derive(Debug, Clone, PartialEq)]
pub enum Abbreviated {
    Number(u32),
    Text(String),
}

pub fn abbreviate(count: u32) -> Abbreviated {
    let js_round = |x: f64| (x + 0.5).floor();
    if count >= 10_000 {
        Abbreviated::Text(format!("{}k", js_round(count as f64 / 1000.0)))
    } else if count >= 1000 {
        Abbreviated::Text(format!("{}k", js_round(count as f64 / 100.0) / 10.0))
    } else {
        Abbreviated::Number(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> Options {
        Options {
            min_zoom: 0,
            max_zoom: 3,
            radius: 60.0,
            extent: 512.0,
            ..Options::default()
        }
    }

    // At z=0 the merge radius is 60/512 = 0.1171875 of the world width; it
    // halves per zoom level. A=(0,0) sits at x=0.5, B=(18°,0) at x=0.55 and
    // C=(-90°,0) at x=0.25.
    //   A–B: 0.05 apart → merged at z=0 (r=0.117) and z=1 (r=0.0586), split at z=2 (r=0.0293)
    //   A–C: 0.25 apart → never merged
    fn points() -> Vec<(f64, f64)> {
        vec![(0.0, 0.0), (18.0, 0.0), (-90.0, 0.0)]
    }

    #[test]
    fn merges_neighbours_within_radius_and_splits_at_higher_zoom() {
        let sc = Supercluster::load(opts(), &points());

        let z0 = sc.world_clusters(0);
        assert_eq!(z0.len(), 2);
        let clusters: Vec<_> = z0
            .iter()
            .filter(|i| matches!(i, Item::Cluster { .. }))
            .collect();
        assert_eq!(clusters.len(), 1);
        match clusters[0] {
            Item::Cluster { lng, lat, count } => {
                assert_eq!(*count, 2);
                // Weighted centre of A and B in projected space: x=0.525 → 9°.
                assert!((lng - 9.0).abs() < 1e-5, "lng {lng}");
                assert!(lat.abs() < 1e-5, "lat {lat}");
            }
            Item::Point(_) => unreachable!(),
        }
        assert!(z0.contains(&Item::Point(2)));

        assert_eq!(sc.world_clusters(1).len(), 2);

        let z2 = sc.world_clusters(2);
        assert_eq!(z2.len(), 3);
        assert!(z2.iter().all(|i| matches!(i, Item::Point(_))));
    }

    #[test]
    fn points_outside_the_mercator_clip_are_not_returned() {
        let sc = Supercluster::load(opts(), &[(0.0, 89.0), (0.0, 0.0)]);
        assert_eq!(sc.world_clusters(3), vec![Item::Point(1)]);
    }

    #[test]
    fn abbreviation_matches_supercluster_formatting() {
        assert_eq!(abbreviate(2), Abbreviated::Number(2));
        assert_eq!(abbreviate(999), Abbreviated::Number(999));
        assert_eq!(abbreviate(1000), Abbreviated::Text("1k".into()));
        assert_eq!(abbreviate(2563), Abbreviated::Text("2.6k".into()));
        assert_eq!(abbreviate(9949), Abbreviated::Text("9.9k".into()));
        assert_eq!(abbreviate(9950), Abbreviated::Text("10k".into()));
        assert_eq!(abbreviate(12_499), Abbreviated::Text("12k".into()));
        assert_eq!(abbreviate(12_500), Abbreviated::Text("13k".into()));
    }

    #[test]
    fn large_set_conserves_every_point() {
        // Enough points to exercise the KD-sort beyond a single leaf (nodeSize 64)
        // and the Floyd-Rivest sampling branch (> 600 items).
        let pts: Vec<(f64, f64)> = (0..3000)
            .map(|i| (6.0 + (i % 60) as f64 * 0.05, 48.0 + (i / 60) as f64 * 0.04))
            .collect();
        let sc = Supercluster::load(
            Options {
                min_zoom: 5,
                max_zoom: 8,
                radius: 60.0,
                ..Options::default()
            },
            &pts,
        );
        for z in 5..=8 {
            let total: usize = sc
                .world_clusters(z)
                .iter()
                .map(|i| match i {
                    Item::Point(_) => 1,
                    Item::Cluster { count, .. } => *count as usize,
                })
                .sum();
            assert_eq!(total, pts.len(), "zoom {z}");
        }
    }
}
