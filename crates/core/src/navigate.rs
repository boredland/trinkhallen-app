//! Turn-by-turn links. Three options are always offered; the primary CTA picks
//! one by User-Agent so iOS gets Apple Maps, Android the `geo:` URI (resolved
//! to the user's default maps app) and desktop Google Maps web.

#[derive(Debug, Clone, PartialEq)]
pub struct NavigateOption {
    pub href: String,
    pub label: &'static str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NavigateTargets {
    pub primary: NavigateOption,
    pub apple: NavigateOption,
    pub geo: NavigateOption,
    pub google: NavigateOption,
}

/// Percent-encodes like JS `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Formats a coordinate the way JS `String(number)` does for typical values.
pub fn js_num(n: f64) -> String {
    if n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

pub fn build_navigate_targets(
    name: &str,
    lat: f64,
    lng: f64,
    user_agent: Option<&str>,
) -> NavigateTargets {
    let ua = user_agent.unwrap_or("").to_lowercase();
    let q = format!("{},{}", js_num(lat), js_num(lng));
    let encoded = encode_uri_component(name);
    let apple = NavigateOption {
        href: format!("maps://?daddr={q}&q={encoded}"),
        label: "Apple Maps",
    };
    let geo = NavigateOption {
        href: format!("geo:{q}?q={q}({encoded})"),
        label: "Google Maps",
    };
    let google = NavigateOption {
        href: format!(
            "https://www.google.com/maps/dir/?api=1&destination={q}&destination_place_id={encoded}"
        ),
        label: "Google Maps (Web)",
    };
    let primary = if ua.contains("iphone") || ua.contains("ipad") || ua.contains("ipod") {
        apple.clone()
    } else if ua.contains("android") {
        geo.clone()
    } else {
        google.clone()
    };
    NavigateTargets {
        primary,
        apple,
        geo,
        google,
    }
}

/// The UA-dependent part of rendered navigate links, for cache keys: two
/// requests in the same bucket render identical HTML.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UaBucket {
    Ios,
    Android,
    Other,
}

impl UaBucket {
    pub fn of(user_agent: Option<&str>) -> Self {
        let ua = user_agent.unwrap_or("").to_lowercase();
        if ua.contains("iphone") || ua.contains("ipad") || ua.contains("ipod") {
            UaBucket::Ios
        } else if ua.contains("android") {
            UaBucket::Android
        } else {
            UaBucket::Other
        }
    }

    /// A UA string that `build_navigate_targets` maps back to this bucket.
    pub fn representative(self) -> Option<&'static str> {
        match self {
            UaBucket::Ios => Some("iphone"),
            UaBucket::Android => Some("android"),
            UaBucket::Other => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            UaBucket::Ios => "ios",
            UaBucket::Android => "android",
            UaBucket::Other => "other",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_by_ua() {
        let t = build_navigate_targets("Café & Co", 50.11, 8.68, Some("Mozilla iPhone"));
        assert!(
            t.primary
                .href
                .starts_with("maps://?daddr=50.11,8.68&q=Caf%C3%A9%20%26%20Co")
        );
        assert!(
            build_navigate_targets("x", 50.0, 8.0, Some("Android"))
                .primary
                .href
                .starts_with("geo:50,8?q=50,8(x)")
        );
        assert!(
            build_navigate_targets("x", 50.0, 8.0, None)
                .primary
                .href
                .starts_with("https://www.google.com/")
        );
    }
}
