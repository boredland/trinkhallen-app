//! CSRF origin check, as defence-in-depth next to the `SameSite=Lax` session
//! cookie: unsafe form-shaped requests must carry a matching `Origin` or
//! `Sec-Fetch-Site: same-origin`.
//!
//! It covers `/api/*`, `/en/api/*`, `/me/*`, `/en/me/*` and `/add` + `/en/add`
//! (the `/add` form is state-changing and same-origin only). `/auth/*` is
//! deliberately excluded — Apple's sign-in callback is a legitimate
//! cross-origin form POST and is guarded by its own state-cookie match.

/// Should this request path be checked at all?
pub fn csrf_protected(method: &str, path: &str) -> bool {
    if method == "GET" || method == "HEAD" {
        return false;
    }
    matches!(path, "/add" | "/en/add")
        || ["/api/", "/en/api/", "/me/", "/en/me/"]
            .iter()
            .any(|p| path.starts_with(p))
}

/// Only requests "requested by a form element" are checked: the three form
/// content types. A missing `Content-Type` counts as `text/plain` (and is
/// therefore checked).
pub fn is_form_content_type(content_type: Option<&str>) -> bool {
    let ct = content_type.unwrap_or("text/plain").to_ascii_lowercase();
    [
        "application/x-www-form-urlencoded",
        "multipart/form-data",
        "text/plain",
    ]
    .iter()
    .any(|p| ct.starts_with(p))
}

/// The whole decision, as a pure function. `req_origin` is the request URL's
/// origin; `origin` the `Origin` header, `sec_fetch_site` the
/// `Sec-Fetch-Site` header.
///
/// Rejects when the request is unsafe, form-shaped and *neither*
/// `Sec-Fetch-Site: same-origin` *nor* an exactly matching `Origin` is
/// present. `Sec-Fetch-Site` wins when present (values other than the four
/// known ones count as absent there).
pub fn csrf_check(
    method: &str,
    content_type: Option<&str>,
    sec_fetch_site: Option<&str>,
    origin: Option<&str>,
    req_origin: &str,
) -> bool {
    if method == "GET" || method == "HEAD" {
        return true;
    }
    if !is_form_content_type(content_type) {
        return true;
    }
    let site_ok = match sec_fetch_site {
        Some(v) if matches!(v, "same-origin" | "same-site" | "none" | "cross-site") => {
            v == "same-origin"
        }
        _ => false,
    };
    if site_ok {
        return true;
    }
    match origin {
        Some(o) => o == req_origin,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://trinkhallen.app";

    #[test]
    fn safe_methods_pass() {
        assert!(csrf_check("GET", None, None, None, ORIGIN));
        assert!(csrf_check("HEAD", None, None, None, ORIGIN));
    }

    #[test]
    fn form_post_without_origin_forbidden() {
        assert!(!csrf_check(
            "POST",
            Some("application/x-www-form-urlencoded"),
            None,
            None,
            ORIGIN
        ));
        // Missing content-type counts as text/plain → still checked.
        assert!(!csrf_check("POST", None, None, None, ORIGIN));
        assert!(!csrf_check(
            "POST",
            Some("multipart/form-data; boundary=x"),
            None,
            None,
            ORIGIN
        ));
    }

    #[test]
    fn non_form_bodies_pass() {
        assert!(csrf_check(
            "POST",
            Some("application/json"),
            None,
            None,
            ORIGIN
        ));
    }

    #[test]
    fn same_origin_signals_pass() {
        assert!(csrf_check("POST", None, Some("same-origin"), None, ORIGIN));
        assert!(csrf_check("POST", None, None, Some(ORIGIN), ORIGIN));
        // Origin check is byte-equal — a different host must not pass.
        assert!(!csrf_check(
            "POST",
            None,
            None,
            Some("https://evil.example"),
            ORIGIN
        ));
        // Sec-Fetch-Site values other than same-origin don't help.
        assert!(!csrf_check("POST", None, Some("same-site"), None, ORIGIN));
        assert!(!csrf_check(
            "POST",
            None,
            Some("cross-site"),
            Some("https://evil.example"),
            ORIGIN
        ));
    }

    #[test]
    fn protected_path_globs() {
        for p in [
            "/api/reports",
            "/en/api/reports",
            "/me/delete",
            "/en/me/delete",
            "/add",
            "/en/add",
        ] {
            assert!(csrf_protected("POST", p), "{p}");
        }
        // /auth/* is guarded by its own state cookie (Apple form_post).
        assert!(!csrf_protected("POST", "/auth/apple/callback"));
        assert!(!csrf_protected("GET", "/api/kiosks"));
    }
}
