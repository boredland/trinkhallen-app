//! Response, cookie and header helpers shared by every route module.
//!
//! Cookie serialisation mirrors hono's `serialize` byte for byte (attribute
//! order included) so existing browser cookie jars keep matching.

use worker::{Request, Response, Result};

/// Response with a fixed body, explicit status and optional extra headers.
pub fn response(
    content_type: &str,
    body: impl Into<Vec<u8>>,
    status: u16,
    headers: &[(&str, &str)],
) -> Result<Response> {
    let mut b = Response::builder()
        .with_status(status)
        .with_header("content-type", content_type)?;
    for (k, v) in headers {
        b = b.with_header(k, v)?;
    }
    Ok(b.fixed(body.into()))
}

pub fn text(body: &str, status: u16) -> Result<Response> {
    response(
        "text/plain; charset=UTF-8",
        body.as_bytes().to_vec(),
        status,
        &[],
    )
}

pub fn html(body: String, status: u16) -> Result<Response> {
    response("text/html; charset=UTF-8", body.into_bytes(), status, &[])
}

pub fn json(body: &str, status: u16, headers: &[(&str, &str)]) -> Result<Response> {
    response(
        "application/json",
        body.as_bytes().to_vec(),
        status,
        headers,
    )
}

/// Empty-body response (204 for the silent check-in log, 30x redirects).
pub fn empty(status: u16, headers: &[(&str, &str)]) -> Result<Response> {
    let mut b = Response::builder().with_status(status);
    for (k, v) in headers {
        b = b.with_header(k, v)?;
    }
    Ok(b.fixed(Vec::new()))
}

/// Redirect with optional `Set-Cookie` values. Cookies are *appended* — a
/// `Headers::set` would replace the previous one and drop the first cookie
/// (the Apple flow clears its state cookie and sets the session cookie in one
/// response).
pub fn redirect(location: &str, status: u16, set_cookies: &[String]) -> Result<Response> {
    let mut resp = Response::builder()
        .with_status(status)
        .with_header("location", location)?
        .fixed(Vec::new());
    for c in set_cookies {
        resp.headers_mut().append("set-cookie", c)?;
    }
    Ok(resp)
}

/// Responses read back from `caches.default` (and other fetched ones) carry
/// immutable headers. A copied `Headers` object is mutable; the body is not
/// touched.
pub fn mutable(resp: Response) -> Response {
    let headers = resp.headers().clone();
    resp.with_headers(headers)
}

/// Attach a `Set-Cookie` value to a response that is already built.
pub fn with_cookie(resp: Response, cookie: &str) -> Result<Response> {
    let mut resp = mutable(resp);
    resp.headers_mut().append("set-cookie", cookie)?;
    Ok(resp)
}

/// hono `setCookie` serialisation: `name=value` then Max-Age, Domain, Path,
/// Expires, HttpOnly, Secure, SameSite in that fixed order.
pub fn cookie_value(
    name: &str,
    value: &str,
    max_age: u32,
    path: &str,
    http_only: bool,
    secure: bool,
    same_site: Option<&str>,
) -> String {
    let mut c = format!("{name}={value}; Max-Age={max_age}; Path={path}");
    if http_only {
        c.push_str("; HttpOnly");
    }
    if secure {
        c.push_str("; Secure");
    }
    if let Some(ss) = same_site {
        let mut chars = ss.chars();
        let head = chars
            .next()
            .map(|c| c.to_ascii_uppercase())
            .unwrap_or_default();
        c.push_str(&format!("; SameSite={head}{}", chars.as_str()));
    }
    c
}

/// hono `deleteCookie`: `name=; Max-Age=0; Path=…` plus the attributes the
/// caller passed (the TS session code passes `path` + `secure` only).
pub fn delete_cookie_value(name: &str, path: &str, secure: bool) -> String {
    let mut c = format!("{name}=; Max-Age=0; Path={path}");
    if secure {
        c.push_str("; Secure");
    }
    c
}

/// First value of `name` in the `Cookie` header, percent-decoded the way
/// hono's `getCookie` does (strict decode, raw value when it fails).
pub fn cookie_header(req: &Request, name: &str) -> Option<String> {
    let raw = req.headers().get("cookie").ok().flatten()?;
    for pair in raw.split(';') {
        let pair = pair.trim();
        if let Some(rest) = pair.strip_prefix(name) {
            if let Some(value) = rest.strip_prefix('=') {
                return Some(crate::util::percent_decode(value, false));
            }
        }
    }
    None
}

pub fn header(req: &Request, name: &str) -> Option<String> {
    req.headers().get(name).ok().flatten()
}
