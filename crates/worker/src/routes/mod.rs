//! Route modules: page renders, JSON/HTML APIs and the well-known document.
//!
//! Dispatch mirrors the TS router (`src/index.ts` + `src/routes/*.tsx`):
//! locale-addressed page routes are matched on the locale-stripped path, API
//! and well-known routes stay root-only, and every handler keeps the response
//! shape of its TS counterpart.

pub mod api_forms;
pub mod api_kiosks;
pub mod pages;
pub mod well_known;

use chrono::{DateTime, Utc};
use trinkhallen_core::filters::KioskFilter;
use trinkhallen_core::geo::LatLng;
use trinkhallen_core::i18n::{Lang, path_for_lang, resolve_lang};
use trinkhallen_core::record::KioskRecord;
use trinkhallen_ui::model::Nav;
use trinkhallen_ui::pages::{PageMeta, PanelData};
use trinkhallen_ui::render::Page;
use worker::{Context, Env, Method, Request, Response, Result};

use crate::http::text;
use crate::panel::panel_view;
use crate::state::RequestState;
use crate::util::{parse_query, query_get};

/// The one 404 body the app returns (`app.notFound`).
pub fn not_found() -> Result<Response> {
    text("404 — Hier gibt's nix.", 404)
}

/// Query parameters with `URLSearchParams` semantics.
pub fn query(state: &RequestState) -> Vec<(String, String)> {
    parse_query(state.url.query().unwrap_or(""))
}

pub fn user_agent(req: &Request) -> Option<String> {
    crate::http::header(req, "user-agent")
}

/// Wrap a rendered page body + its [`PageMeta`] in the full document.
pub fn document(state: &RequestState, meta: &PageMeta, body: String) -> String {
    let mut page = Page::new(
        state.lang,
        state.path.clone(),
        state.nonce.clone(),
        state.assets.clone(),
    );
    page.title = meta.title.clone();
    page.description = meta.description.clone();
    page.canonical_url = meta.canonical_url.clone();
    page.noindex = meta.noindex;
    page.json_ld = meta.json_ld.clone();
    if !meta.entries.is_empty() {
        page.entries = meta.entries.clone();
    }
    page.full_bleed = meta.full_bleed;
    page.nav = meta.nav.unwrap_or(Nav::Map);
    page.user = state.user.clone();
    trinkhallen_ui::render::document(&page, body)
}

pub fn page(state: &RequestState, meta: PageMeta, body: String) -> Result<Response> {
    crate::http::html(document(state, &meta, body), 200)
}

pub fn page_status(
    state: &RequestState,
    meta: PageMeta,
    body: String,
    status: u16,
) -> Result<Response> {
    crate::http::html(document(state, &meta, body), status)
}

/// Side-panel fragment data for one bbox: filter → sort → count → cut at 100.
/// `has_bbox` distinguishes the real panel from the empty-bbox placeholder
/// (which carries no counters and no reset link, like the TS `KioskList`).
pub fn build_panel<'a>(
    lang: Lang,
    all: &[&'a KioskRecord],
    filter: &KioskFilter,
    origin: Option<LatLng>,
    user_agent: Option<String>,
    now: DateTime<Utc>,
    has_bbox: bool,
) -> PanelData<'a> {
    let view = panel_view(all, filter, origin, now);
    PanelData {
        lang,
        kiosks: view.kiosks,
        total_in_bbox: view.total_in_bbox,
        filtered_count: view.filtered_count,
        open_now_count: has_bbox.then_some(view.open_now_count),
        filter_active: has_bbox && filter.is_active(),
        reset_href: has_bbox.then(|| path_for_lang("/", lang)),
        origin,
        user_agent,
    }
}

/// Locale-stripped path: `/en/k/x` → `/k/x`, `/en` → `/`. Page routes are
/// registered once and served under both mounts.
pub fn bare_path(path: &str) -> String {
    path_for_lang(path, Lang::De)
}

/// The kiosk id in an `/api/kiosks/<id>` path, or `None` for the named
/// sub-routes (`panel`, `nearest`, `nearest-open`) which the TS router
/// registers ahead of `:id`.
fn kiosk_id_of(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/api/kiosks/")?;
    if rest.is_empty() || rest.contains('/') || matches!(rest, "panel" | "nearest" | "nearest-open")
    {
        return None;
    }
    Some(rest)
}

pub fn is_kiosk_id_path(path: &str) -> bool {
    kiosk_id_of(path).is_some()
}

/// Router. Session load, CSRF and the language decision have already run.
pub async fn dispatch(
    req: Request,
    env: &Env,
    ctx: &Context,
    state: &RequestState,
) -> Result<Response> {
    let path = state.path.as_str();
    let bare = bare_path(path);
    let method = req.method();

    // Auth owns every `/auth/*` route (Google/Apple/magic/logout).
    if path.starts_with("/auth/") {
        return match crate::auth::handle(req, env, ctx, state).await {
            Some(res) => res,
            None => not_found(),
        };
    }

    // Moderation subtree: the role gate runs for every verb (the TS
    // `requireModerator` middleware), the decision endpoints live in the
    // moderation slice.
    if path.starts_with("/api/moderate/") {
        if let Some(res) = crate::moderation::require_moderator(state) {
            return Ok(res);
        }
        return if method == Method::Post {
            match crate::moderation::handle(req, env, ctx, state).await {
                Some(res) => res,
                None => not_found(),
            }
        } else {
            not_found()
        };
    }

    // API + well-known stay root-only (the client passes the locale along
    // explicitly) — `/en/api/...` is a 404, as in the TS router.
    if path.starts_with("/api/") {
        return api_dispatch(req, env, ctx, state, &bare).await;
    }
    if path == "/.well-known/assetlinks.json" {
        return well_known::assetlinks();
    }

    pages::dispatch(req, env, ctx, state, &bare).await
}

async fn api_dispatch(
    req: Request,
    env: &Env,
    ctx: &Context,
    state: &RequestState,
    bare: &str,
) -> Result<Response> {
    match (req.method(), bare) {
        (Method::Get, "/api/kiosks") => api_kiosks::collection(req, env, ctx, state).await,
        (Method::Get, "/api/kiosks/panel") => api_kiosks::panel(req, env, state).await,
        (Method::Get, "/api/kiosks/nearest") => api_kiosks::nearest(req, env, state).await,
        (Method::Get, "/api/kiosks/nearest-open") => {
            api_kiosks::nearest_open(req, env, state).await
        }
        (Method::Get, _) if kiosk_id_of(bare).is_some() => {
            api_kiosks::by_id(env, state, kiosk_id_of(bare).unwrap()).await
        }
        (Method::Post, "/api/checkins") => api_forms::checkin(req, env, ctx, state).await,
        (Method::Post, "/api/signals") => api_forms::signal(req, env, state).await,
        (Method::Post, "/api/ratings") => api_forms::rate(req, env, state).await,
        (Method::Post, "/api/ratings/delete") => api_forms::rate_delete(req, env, state).await,
        (Method::Post, "/api/reports") => api_forms::report(req, env, ctx, state).await,
        _ => not_found(),
    }
}

/// POST `/add` (+ `/en/add`) — the human-shareable submission form.
pub async fn submit_add(req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    api_forms::submit_add(req, env, state).await
}

/// Language of an API request: `?lang=` (baked into `data-panel-url`) first,
/// Accept-Language only as the fallback for a bare fetch.
pub fn api_lang(req: &Request, state: &RequestState) -> Lang {
    let q = query(state);
    match query_get(&q, "lang") {
        Some(l) => resolve_lang(Some(l)),
        None => resolve_lang(crate::http::header(req, "accept-language").as_deref()),
    }
}

/// `parseInt(s, 10)` for the `?limit=` knob (leading digits, NaN otherwise).
pub fn parse_int_js(s: &str) -> f64 {
    let t = s.trim_start();
    let (sign, t) = match t.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    sign * digits.parse::<f64>().unwrap_or(f64::NAN)
}

pub fn clamp(n: f64, lo: f64, hi: f64) -> f64 {
    if !n.is_finite() {
        return lo;
    }
    n.max(lo).min(hi)
}

/// "Now" for the open-now evaluations (UTC wall clock — see the
/// `trinkhallen_core::hours` module docs).
pub fn now() -> DateTime<Utc> {
    DateTime::from_timestamp(crate::util::now(), 0).unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_paths_fall_back_to_the_root_mount() {
        assert_eq!(bare_path("/en"), "/");
        assert_eq!(bare_path("/en/k/tk_fr_1"), "/k/tk_fr_1");
        assert_eq!(bare_path("/k/tk_fr_1"), "/k/tk_fr_1");
        assert_eq!(bare_path("/en/stadt/frankfurt"), "/stadt/frankfurt");
    }

    #[test]
    fn kiosk_id_paths_skip_the_named_sub_routes() {
        assert_eq!(kiosk_id_of("/api/kiosks/tk_fr_1"), Some("tk_fr_1"));
        assert_eq!(kiosk_id_of("/api/kiosks"), None);
        assert_eq!(kiosk_id_of("/api/kiosks/a/b"), None);
        assert!(!is_kiosk_id_path("/api/kiosks/nearest"));
        assert!(!is_kiosk_id_path("/api/kiosks/panel"));
        assert!(!is_kiosk_id_path("/api/kiosks/nearest-open"));
        assert!(is_kiosk_id_path("/api/kiosks/tk_fr_1"));
    }

    #[test]
    fn parse_int_matches_javascript() {
        assert_eq!(parse_int_js("5000"), 5000.0);
        assert_eq!(parse_int_js("10x"), 10.0);
        assert_eq!(parse_int_js(" 7"), 7.0);
        assert_eq!(parse_int_js("0x10"), 0.0);
        assert!(parse_int_js("x").is_nan());
        assert_eq!(clamp(parse_int_js("x"), 1.0, 10_000.0), 1.0);
        assert_eq!(clamp(20_000.0, 1.0, 10_000.0), 10_000.0);
    }
}
