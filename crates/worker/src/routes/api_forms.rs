//! Form-driven APIs: check-ins, signals, ratings, reports and the `/add`
//! submission — ports of `src/routes/api.{checkins,signals,ratings,reports,
//! submissions}.tsx`.

use serde_json::{Map, Value, json};
use trinkhallen_core::geo::LatLng;
use trinkhallen_core::i18n::{Lang, path_for_lang, resolve_lang, t};
use trinkhallen_core::tags::reportable_tags;
use trinkhallen_ui::model::SessionUser;
use worker::{Context, Env, FormData, Request, Response, Result};

use crate::assets;
use crate::checkins::{
    CheckinInput, file_observation_if_new, ph_observation_date, record_checkin,
    region_slug_from_path,
};
use crate::http;
use crate::notify::{ReportNotification, notify_new_report};
use crate::ratings;
use crate::reports as report_store;
use crate::signals::{RecordSignalInput, SignalAction, record_signal};
use crate::state::RequestState;
use crate::submissions;

fn api_error(lang: Lang, key: &str, status: u16) -> Result<Response> {
    http::text(&t(lang, key), status)
}

/// Geolocation fields of a check-in/signal form: a fix only counts when both
/// coordinates parse and are finite; accuracy pads the verify radius.
fn opt_coords(form: &FormData) -> (Option<LatLng>, Option<f64>) {
    let parse = |name: &str| form.get_field(name).unwrap_or_default().parse::<f64>().ok();
    let point = match (parse("lat"), parse("lng")) {
        (Some(lat), Some(lng)) if lat.is_finite() && lng.is_finite() => Some(LatLng { lat, lng }),
        _ => None,
    };
    (point, parse("accuracy").filter(|a| *a >= 0.0))
}

/// Display handle for the reporter — `@username` or the email address.
fn reporter(user: &SessionUser) -> String {
    match &user.username {
        Some(u) => format!("@{u}"),
        None => user.email.clone(),
    }
}

/// `String.prototype.slice(0, n)` on the char count.
fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// `POST /api/checkins` — silent "I was here" event log. Lat/lng are
/// optional; when supplied and within 100 m the row gets `verified=1`. The
/// form continues either way — verification is for future leaderboard
/// scoring, not for gating writes. Same-day re-taps are no-ops.
pub async fn checkin(
    mut req: Request,
    env: &Env,
    ctx: &Context,
    state: &RequestState,
) -> Result<Response> {
    let lang = resolve_lang(http::header(&req, "accept-language").as_deref());
    let Some(user) = state.user.clone() else {
        return api_error(lang, "error.loginRequired", 401);
    };
    let form = req.form_data().await?;
    let kiosk_id = form.get_field("kiosk_id").unwrap_or_default();
    if kiosk_id.is_empty() {
        return api_error(lang, "error.badRequest", 400);
    }
    let Some(kiosk) = assets::get_kiosk_by_id(env, &kiosk_id).await? else {
        return api_error(lang, "error.kioskNotFound", 404);
    };

    let (user_point, accuracy) = opt_coords(&form);
    let outcome = record_checkin(
        env,
        &CheckinInput {
            kiosk_id: &kiosk.id,
            kiosk: LatLng {
                lat: kiosk.lat,
                lng: kiosk.lng,
            },
            region_slug: &region_slug_from_path(&kiosk.region),
            user_id: &user.id,
            user: user_point,
            accuracy,
        },
    )
    .await?;

    // PH-data-gap capture: a verified check-in landing on a public holiday at
    // a kiosk whose hours carry no PH rule is strong evidence it is open
    // today; the moderator confirms before the data repo gets touched.
    if outcome.inserted && outcome.verified && kiosk.hours_raw().is_some() {
        if let Some(date) =
            ph_observation_date(kiosk.hours_raw(), &kiosk.region, crate::routes::now())
        {
            file_observation_if_new(
                env,
                ctx,
                &kiosk.id,
                &kiosk.name,
                &reporter(&user),
                &user.id,
                &date,
            )
            .await?;
        }
    }

    // The check-in is silent in V1 — no UI consumes the response. The form on
    // the page reveals the gap questions client-side regardless of outcome.
    http::empty(204, &[])
}

/// `POST /api/signals` — always-record write path for per-field signals.
/// Response is a small JSON `{ verified, reason }` so the client can show
/// high- vs low-confidence feedback.
pub async fn signal(mut req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let lang = resolve_lang(http::header(&req, "accept-language").as_deref());
    let Some(user) = state.user.clone() else {
        return api_error(lang, "error.loginRequired", 401);
    };
    let form = req.form_data().await?;
    let kiosk_id = form.get_field("kiosk_id").unwrap_or_default();
    let field_key = form.get_field("field_key").unwrap_or_default();
    let action_raw = form.get_field("action").unwrap_or_default();
    if kiosk_id.is_empty() || field_key.is_empty() || action_raw.is_empty() {
        return api_error(lang, "error.badRequest", 400);
    }
    let Some(action) = SignalAction::parse(&action_raw) else {
        return api_error(lang, "error.badAction", 400);
    };
    let Some(kiosk) = assets::get_kiosk_by_id(env, &kiosk_id).await? else {
        return api_error(lang, "error.kioskNotFound", 404);
    };

    let (user_point, accuracy) = opt_coords(&form);
    let asserted = form.get_field("asserted_value").filter(|v| !v.is_empty());
    let result = record_signal(
        &env.d1("DB")?,
        &RecordSignalInput {
            kiosk_id: &kiosk.id,
            kiosk: LatLng {
                lat: kiosk.lat,
                lng: kiosk.lng,
            },
            region_slug: &region_slug_from_path(&kiosk.region),
            user_id: &user.id,
            field_key: &field_key,
            action,
            asserted_value: asserted.as_deref(),
            user: user_point,
            accuracy,
        },
    )
    .await?;

    let body = json!({ "verified": result.verified, "reason": result.reason.map(|r| r.code()) })
        .to_string();
    http::json(&body, 200, &[])
}

/// `POST /api/ratings` — one rating per user per kiosk.
pub async fn rate(mut req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let lang = resolve_lang(http::header(&req, "accept-language").as_deref());
    let Some(user) = state.user.clone() else {
        return api_error(lang, "error.loginRequired", 401);
    };
    let form = req.form_data().await?;
    let kiosk_id = form.get_field("kiosk_id").unwrap_or_default();
    let stars: i64 = form
        .get_field("stars")
        .unwrap_or_default()
        .parse()
        .unwrap_or(0);
    let comment = form
        .get_field("comment")
        .unwrap_or_default()
        .trim()
        .to_owned();

    if kiosk_id.is_empty() {
        return http::text("kiosk_id missing", 400);
    }
    if !(1..=5).contains(&stars) {
        return http::text("stars must be 1..5", 400);
    }
    let Some(kiosk) = assets::get_kiosk_by_id(env, &kiosk_id).await? else {
        return http::text("kiosk not found", 404);
    };

    let comment = (!comment.is_empty() && comment.chars().count() <= 500).then_some(comment);
    ratings::upsert_rating(
        &env.d1("DB")?,
        &kiosk.id,
        &user.id,
        stars as u8,
        comment.as_deref(),
    )
    .await?;
    render_fragment_or_redirect(&req, env, lang, &kiosk.id, &user.id).await
}

/// `POST /api/ratings/delete`
pub async fn rate_delete(mut req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let lang = resolve_lang(http::header(&req, "accept-language").as_deref());
    let Some(user) = state.user.clone() else {
        return api_error(lang, "error.loginRequired", 401);
    };
    let form = req.form_data().await?;
    let kiosk_id = form.get_field("kiosk_id").unwrap_or_default();
    if kiosk_id.is_empty() {
        return http::text("kiosk_id missing", 400);
    }
    ratings::delete_rating(&env.d1("DB")?, &kiosk_id, &user.id).await?;
    render_fragment_or_redirect(&req, env, lang, &kiosk_id, &user.id).await
}

/// The client island sends `X-Tk-Fragment: 1` and swaps `#rating-block` in
/// place. A plain form submit (no JS) lacks the header and falls through to
/// the redirect so the full kiosk page re-renders with the new rating.
async fn render_fragment_or_redirect(
    req: &Request,
    env: &Env,
    lang: Lang,
    kiosk_id: &str,
    user_id: &str,
) -> Result<Response> {
    let db = env.d1("DB")?;
    let (aggregate, own, comments) = futures_util::try_join!(
        ratings::get_aggregate(&db, kiosk_id),
        ratings::get_own_rating(&db, kiosk_id, user_id),
        ratings::list_comments(&db, lang, kiosk_id, 50),
    )?;
    if http::header(req, "x-tk-fragment").as_deref() == Some("1") {
        let block = trinkhallen_ui::pages::kiosk::rating_block(
            lang,
            kiosk_id,
            &aggregate,
            own.as_ref(),
            &comments,
            true,
        );
        return http::html(block, 200);
    }
    http::redirect(&format!("/k/{kiosk_id}"), 302, &[])
}

/// `POST /api/reports` — "Daten falsch?" corrections, stored with a
/// per-kind structured payload so moderators see a one-glance diff.
pub async fn report(
    mut req: Request,
    env: &Env,
    ctx: &Context,
    state: &RequestState,
) -> Result<Response> {
    let lang = resolve_lang(http::header(&req, "accept-language").as_deref());
    let Some(user) = state.user.clone() else {
        return api_error(lang, "error.loginRequired", 401);
    };
    let form = req.form_data().await?;
    let kiosk_id = form.get_field("kiosk_id").unwrap_or_default();
    let kind = form.get_field("kind").unwrap_or_default();
    if kiosk_id.is_empty() || !report_store::is_allowed_kind(&kind) {
        return api_error(lang, "error.badRequest", 400);
    }
    let Some(kiosk) = assets::get_kiosk_by_id(env, &kiosk_id).await? else {
        return api_error(lang, "error.kioskNotFound", 404);
    };

    // One report per (user, kiosk, kind) at a time. The UI already filters out
    // kinds the user has in flight, but a stale tab + a fresh submit can still
    // race — reject here too.
    if report_store::has_blocking_report(&env.d1("DB")?, &kiosk.id, &user.id, &kind).await? {
        return api_error(lang, "error.alreadyReportedKind", 409);
    }

    // Capture per-kind structured payload so moderators see a one-glance diff.
    let mut payload = Map::new();
    let mut put = |key: &str, value: Value| payload.insert(key.to_owned(), value);
    let note = form.get_field("note").unwrap_or_default().trim().to_owned();
    if !note.is_empty() {
        put("note", clip(&note, 500).into());
    }

    match kind.as_str() {
        "wrong_hours" => {
            let hours = form
                .get_field("new_hours")
                .unwrap_or_default()
                .trim()
                .to_owned();
            if !hours.is_empty() {
                put("new_hours", clip(&hours, 200).into());
            }
        }
        "wrong_address" => {
            let mut next = Map::new();
            for key in ["new_street", "new_number", "new_postalcode", "new_city"] {
                let v = form.get_field(key).unwrap_or_default().trim().to_owned();
                if !v.is_empty() {
                    next.insert(key.trim_start_matches("new_").to_owned(), v.into());
                }
            }
            if !next.is_empty() {
                put("new_address", Value::Object(next));
            }
        }
        "wrong_name" => {
            let name = form
                .get_field("new_name")
                .unwrap_or_default()
                .trim()
                .to_owned();
            if !name.is_empty() {
                put("new_name", clip(&name, 120).into());
            }
        }
        "update_payment" => {
            // Whitelist both the key and the tri-state value so moderation
            // never sees a payload it can't apply.
            let mut payment = Map::new();
            for key in ["cash", "cards", "contactless", "girocard"] {
                let v = form
                    .get_field(&format!("pay_{key}"))
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                if v == "yes" || v == "no" || v == "unknown" {
                    payment.insert(key.into(), v.into());
                }
            }
            if !payment.is_empty() {
                put("payment", Value::Object(payment));
            }
        }
        "update_tags" => {
            // Field name convention: `tag_<slug>` = "yes" | "no" | "" (skip).
            let (mut add, mut remove) = (Vec::new(), Vec::new());
            for slug in reportable_tags() {
                match form
                    .get_field(&format!("tag_{slug}"))
                    .unwrap_or_default()
                    .as_str()
                {
                    "yes" => add.push(Value::String(slug.to_owned())),
                    "no" => remove.push(Value::String(slug.to_owned())),
                    _ => {}
                }
            }
            if !add.is_empty() {
                put("add_tags", Value::Array(add));
            }
            if !remove.is_empty() {
                put("remove_tags", Value::Array(remove));
            }
        }
        _ => {}
    }

    // Drop no-op reports: a structured kind with nothing to apply (e.g. every
    // payment option left at "weiß nicht") would create a report that can
    // never produce a real diff. closed/duplicate/other carry their meaning
    // in kind + note, so they are always allowed.
    let required_keys: &[&str] = match kind.as_str() {
        "wrong_hours" => &["new_hours"],
        "wrong_address" => &["new_address"],
        "wrong_name" => &["new_name"],
        "update_payment" => &["payment"],
        "update_tags" => &["add_tags", "remove_tags"],
        _ => &[],
    };
    let payload = Value::Object(payload);
    if !required_keys.is_empty() && !required_keys.iter().any(|k| payload.get(k).is_some()) {
        return thanks_or_redirect(&req, lang, &kiosk.id);
    }

    let id = crate::auth::users::uuid_v4();
    report_store::insert_report(&env.d1("DB")?, &id, &kiosk.id, &user.id, &kind, &payload).await?;
    notify_new_report(
        env,
        ctx,
        ReportNotification {
            id,
            kiosk_id: kiosk.id.clone(),
            kiosk_name: kiosk.name.clone(),
            kind,
            payload,
            reporter: reporter(&user),
        },
    );

    // Reports sit in D1 with status='open' until a moderator approves on
    // /moderate. Approval is what opens the PR/issue — see moderation.rs.
    thanks_or_redirect(&req, lang, &kiosk.id)
}

/// `<p class="text-sm italic text-fg-dim">…</p>` for fragment submissions
/// (gap-fill chip groups in CheckinForm), a redirect for plain form submits
/// (the legacy ReportForm "Daten falsch?").
fn thanks_or_redirect(req: &Request, lang: Lang, kiosk_id: &str) -> Result<Response> {
    if http::header(req, "x-tk-fragment").as_deref() == Some("1") {
        return http::html(
            format!(
                "<p class=\"text-sm italic text-fg-dim\">{}</p>",
                t(lang, "reports.thanksReviewing")
            ),
            200,
        );
    }
    http::redirect(&format!("/k/{kiosk_id}?reported=ok"), 302, &[])
}

/// `POST /add` (mounted at `/add` and `/en/add`) — validates a proposed
/// Kiosk Feature and stores it for moderator review. Redirects are
/// locale-aware so the English form stays in English.
pub async fn submit_add(mut req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let lang = state.lang;
    let add = path_for_lang("/add", lang);
    let me = path_for_lang("/me", lang);
    let Some(user) = state.user.clone() else {
        return http::redirect(&format!("{me}?after=add"), 302, &[]);
    };

    let form = req.form_data().await?;
    let name = form.get_field("name").unwrap_or_default().trim().to_owned();
    let lat = form
        .get_field("lat")
        .unwrap_or_default()
        .parse::<f64>()
        .unwrap_or(f64::NAN);
    let lng = form
        .get_field("lng")
        .unwrap_or_default()
        .parse::<f64>()
        .unwrap_or(f64::NAN);
    if name.is_empty() || !lat.is_finite() || !lng.is_finite() {
        return http::redirect(&format!("{add}?error=basics"), 302, &[]);
    }
    if lat < -90.0 || lat > 90.0 || lng < -180.0 || lng > 180.0 {
        return http::redirect(&format!("{add}?error=coords"), 302, &[]);
    }
    let Some(feature) = submissions::build_feature(&form) else {
        return http::redirect(&format!("{add}?error=basics"), 302, &[]);
    };

    submissions::store_submission(&env.d1("DB")?, &user.id, &feature).await?;
    // Submissions sit in D1 with status='pending' until a moderator approves
    // on /moderate. Approval is what opens the PR — see moderation.rs.
    http::redirect(&format!("{me}?submitted=ok"), 302, &[])
}
