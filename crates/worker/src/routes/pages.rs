//! Page routes — port of `src/routes/pages.tsx`.
//!
//! Each handler assembles the `trinkhallen_ui::pages::*` data struct (the
//! binding contract in `crates/ui/src/pages/mod.rs`) and wraps the rendered
//! body in the document. SQL is ported verbatim from the TS handlers.

use std::collections::BTreeMap;

use trinkhallen_core::geo::{LatLng, bbox_around, parse_bbox, parse_lat_lng};
use trinkhallen_core::hours::{count_open_now, is_public_holiday, kiosk_state};
use trinkhallen_core::i18n::path_for_lang;
use trinkhallen_core::record::KioskRecord;
use trinkhallen_ui::components::city_display_name;
use trinkhallen_ui::model::{NearbyKiosk, Role};
use trinkhallen_ui::pages::{
    AboutData, AddData, CityData, KioskDetailData, LoginData, MapData, ModAnomaly, ModReport,
    ModSubmission, ModTab, ModUser, ModerateData, ProfileData, ProfileReport, ProfileSubmission,
};
use worker::{Context, Env, Method, Request, Response, Result};

use crate::assets;
use crate::db;
use crate::http::redirect;
use crate::panel::de_sort_key;
use crate::ratings;
use crate::reports as report_store;
use crate::routes::{build_panel, not_found, now, page, page_status, query};
use crate::state::RequestState;
use crate::users;
use crate::util::{env_str, query_get};

pub async fn dispatch(
    req: Request,
    env: &Env,
    _ctx: &Context,
    state: &RequestState,
    bare: &str,
) -> Result<Response> {
    let q = query(state);
    match (req.method(), bare) {
        (Method::Get, "/") => map_page(env, state, &q).await,
        (Method::Get, "/list") => redirect("/", 301, &[]),
        (Method::Get, "/jetzt") => jetzt_page(state),
        (Method::Get, "/about") => about_page(env, state).await,
        (Method::Get, "/impressum") => legal_page(state, false),
        (Method::Get, "/datenschutz") => legal_page(state, true),
        (Method::Get, p) if p.starts_with("/stadt/") => {
            city_page(env, state, &p["/stadt/".len()..]).await
        }
        (Method::Get, p) if p.starts_with("/k/") => {
            kiosk_page(&req, env, state, &p["/k/".len()..], &q).await
        }
        (Method::Get, "/add") => add_page(state, &q),
        (Method::Post, "/add") => crate::routes::submit_add(req, env, state).await,
        (Method::Get, "/me") => me_page(env, state, &q).await,
        (Method::Post, "/me/username") => me_username(req, env, state).await,
        (Method::Post, "/me/delete") => me_delete(req, env, state).await,
        (Method::Get, "/moderate") => moderate_page(env, state, &q).await,
        _ => not_found(),
    }
}

// ── /  (map page) ───────────────────────────────────────────────────────────

/// Side-panel bbox resolution, in priority order:
///   1. `?bbox=w,s,e,n` (the canonical share-URL shape)
///   2. `?c=lat,lng` → ~5 km box around the centre, so deep links into
///      Berlin/Köln/etc render with that city's kiosks in the sidebar
///   3. Frankfurt fallback.
async fn map_page(env: &Env, state: &RequestState, q: &[(String, String)]) -> Result<Response> {
    let lang = state.lang;
    let filter = trinkhallen_core::filters::parse_filter(|k| query_get(q, k));
    let search = state
        .url
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let initial_bbox = parse_bbox(query_get(q, "bbox"))
        .or_else(|| parse_lat_lng(query_get(q, "c")).map(bbox_around))
        .or_else(|| parse_bbox(Some("8.4,50.0,8.9,50.3")))
        .unwrap();

    let set = assets::query_kiosks_in_bbox(env, initial_bbox, 5000).await?;
    let refs = set.refs();
    let panel = build_panel(
        lang,
        &refs,
        &filter,
        None,
        state.user_agent.clone(),
        now(),
        true,
    );

    let data = MapData {
        lang,
        filter,
        search,
        focused: None,
        initial_bbox: Some(initial_bbox),
        panel,
    };
    let (body, meta) = trinkhallen_ui::pages::map::render(&data);
    page(state, meta, body)
}

// ── /k/:id ──────────────────────────────────────────────────────────────────

async fn kiosk_page(
    req: &Request,
    env: &Env,
    state: &RequestState,
    id: &str,
    q: &[(String, String)],
) -> Result<Response> {
    let lang = state.lang;
    let partial = query_get(q, "partial") == Some("1");
    let Some(kiosk) = assets::get_kiosk_by_id(env, id).await? else {
        if partial {
            return crate::http::text("not found", 404);
        }
        let (body, meta) = trinkhallen_ui::pages::kiosk::not_found(lang, id);
        return page_status(state, meta, body, 404);
    };

    let db = env.d1("DB")?;
    let user = &state.user;
    let (aggregate, own_rating, rating_comments, nearby_set, user_reports) = futures_util::try_join!(
        ratings::get_aggregate(&db, &kiosk.id),
        async {
            match user {
                Some(u) => ratings::get_own_rating(&db, &kiosk.id, &u.id).await,
                None => Ok(None),
            }
        },
        ratings::list_comments(&db, lang, &kiosk.id, 50),
        assets::find_nearby_kiosks(
            env,
            LatLng {
                lat: kiosk.lat,
                lng: kiosk.lng
            },
            &kiosk.id,
            5
        ),
        async {
            match user {
                Some(u) => report_store::get_user_reports(&db, &kiosk.id, &u.id).await,
                None => Ok(Vec::new()),
            }
        },
    )?;

    let nearby: Vec<NearbyKiosk> = (0..nearby_set.len())
        .map(|i| {
            let (record, distance) = (nearby_set.record(i), nearby_set.distance(i));
            NearbyKiosk {
                id: record.id.clone(),
                name: record.name.clone(),
                district: record.addr("district").map(str::to_owned),
                distance,
                lng: record.lng,
                lat: record.lat,
            }
        })
        .collect();

    let data = KioskDetailData {
        lang,
        kiosk: &kiosk,
        user_agent: crate::http::header(req, "user-agent"),
        aggregate,
        own_rating,
        rating_comments,
        is_logged_in: user.is_some(),
        nearby,
        user_reports,
        is_public_holiday: is_public_holiday(kiosk_state(&kiosk), now()),
        now_unix: crate::util::now(),
    };

    // ?partial=1 → bare HTML the client sheet swaps in over the map.
    if partial {
        return crate::http::html(trinkhallen_ui::pages::kiosk::detail(&data), 200);
    }
    let (body, meta) = trinkhallen_ui::pages::kiosk::standalone(&data);
    page(state, meta, body)
}

// ── /stadt/:slug ────────────────────────────────────────────────────────────

async fn city_page(env: &Env, state: &RequestState, slug: &str) -> Result<Response> {
    let lang = state.lang;
    let (manifest, kiosks) = futures_util::try_join!(
        assets::load_manifest(env),
        assets::kiosks_by_region(env, slug)
    )?;
    let region = manifest.regions.iter().find(|r| r.slug == slug);
    if region.is_none() || kiosks.is_empty() {
        let (body, meta) = trinkhallen_ui::pages::city::not_found(lang, slug);
        return page_status(state, meta, body, 404);
    }

    let mut sorted: Vec<&KioskRecord> = kiosks.iter().collect();
    sorted.sort_by(|a, b| de_sort_key(&a.name).cmp(&de_sort_key(&b.name)));
    let open_now = count_open_now(&sorted, now());
    let total = sorted.len();
    let visible: Vec<&KioskRecord> = sorted.into_iter().take(100).collect();

    let region = region.unwrap();
    let [w, s, e, n] = region.bbox;
    let map_href = format!(
        "{}?c={:.4},{:.4}&z=12",
        path_for_lang("/", lang),
        (s + n) / 2.0,
        (w + e) / 2.0
    );

    let data = CityData {
        lang,
        slug: slug.to_owned(),
        city: city_display_name(slug),
        total,
        open_now,
        visible,
        map_href,
        user_agent: state.user_agent.clone(),
    };
    let (body, meta) = trinkhallen_ui::pages::city::render(&data);
    page(state, meta, body)
}

// ── static pages ────────────────────────────────────────────────────────────

async fn about_page(env: &Env, state: &RequestState) -> Result<Response> {
    let db = env.d1("DB")?;
    let (total, ratings_count, users_count) = futures_util::try_join!(
        assets::count_kiosks(env),
        ratings::count_ratings(&db),
        users::count_users(&db),
    )?;
    let data = AboutData {
        lang: state.lang,
        total,
        ratings: ratings_count,
        users: users_count,
    };
    let (body, meta) = trinkhallen_ui::pages::about::render(&data);
    page(state, meta, body)
}

fn legal_page(state: &RequestState, privacy: bool) -> Result<Response> {
    let (body, meta) = if privacy {
        trinkhallen_ui::pages::legal::datenschutz(state.lang)
    } else {
        trinkhallen_ui::pages::legal::impressum(state.lang)
    };
    page(state, meta, body)
}

/// PWA shortcut: "find the nearest currently-open kiosk and open native Maps".
/// Needs browser geolocation; the page holds the user-gesture flow and
/// degrades gracefully to the map on denial or no results.
fn jetzt_page(state: &RequestState) -> Result<Response> {
    let (body, meta) = trinkhallen_ui::pages::jetzt::render(state.lang, &state.nonce);
    page(state, meta, body)
}

// ── /add ────────────────────────────────────────────────────────────────────

fn add_page(state: &RequestState, q: &[(String, String)]) -> Result<Response> {
    let lang = state.lang;
    if state.user.is_none() {
        return redirect(
            &format!("{}?after=add", path_for_lang("/me", lang)),
            302,
            &[],
        );
    }
    let data = AddData {
        lang,
        initial_lat: query_get(q, "lat").unwrap_or("").to_owned(),
        initial_lng: query_get(q, "lng").unwrap_or("").to_owned(),
        error: query_get(q, "error").map(str::to_owned),
    };
    let (body, meta) = trinkhallen_ui::pages::add::render(&data);
    page(state, meta, body)
}

// ── /me ─────────────────────────────────────────────────────────────────────

async fn me_page(env: &Env, state: &RequestState, q: &[(String, String)]) -> Result<Response> {
    let lang = state.lang;
    let Some(user) = state.user.clone() else {
        let data = LoginData {
            lang,
            magic: query_get(q, "magic").map(str::to_owned),
            turnstile_site_key: env_str(env, "TURNSTILE_SITE_KEY"),
            nonce: state.nonce.clone(),
        };
        let (body, meta) = trinkhallen_ui::pages::account::login(&data);
        return page(state, meta, body);
    };

    #[derive(serde::Deserialize)]
    struct ReportRow {
        id: String,
        kiosk_id: String,
        kind: String,
        status: String,
        pr_url: Option<String>,
        created_at: f64,
    }
    #[derive(serde::Deserialize)]
    struct SubmissionRow {
        id: String,
        payload: String,
        status: String,
        pr_url: Option<String>,
        created_at: f64,
    }
    #[derive(serde::Deserialize)]
    struct Count {
        n: u64,
    }
    #[derive(serde::Deserialize)]
    struct Changed {
        #[serde(rename = "changedAt")]
        changed_at: Option<f64>,
    }

    let db = env.d1("DB")?;
    // Hoisted: `try_join!` drops call-site temporaries before the futures
    // finish, so the bind array has to outlive the join.
    let args = [db::Arg::Text(user.id.as_str())];
    let (report_rows, submission_rows, ratings_count, checkins_count, username_row, signals_count) =
        futures_util::try_join!(
            db::rows::<ReportRow>(
                &db,
                "SELECT r.id, r.kiosk_id, r.kind, r.status, r.pr_url, r.created_at
         FROM reports r
         WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 50",
                &args,
            ),
            db::rows::<SubmissionRow>(
                &db,
                "SELECT id, payload, status, pr_url, created_at FROM submissions
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
                &args,
            ),
            db::one::<Count>(
                &db,
                "SELECT COUNT(*) AS n FROM ratings WHERE user_id = ?",
                &args
            ),
            db::one::<Count>(
                &db,
                "SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?",
                &args
            ),
            db::one::<Changed>(
                &db,
                "SELECT username_changed_at AS changedAt FROM users WHERE id = ?",
                &args,
            ),
            db::one::<Count>(
                &db,
                "SELECT COUNT(*) AS n FROM field_signals WHERE user_id = ?",
                &args
            ),
        )?;

    // Kiosk names for the report list (the rows only carry ids).
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for id in report_rows.iter().map(|r| &r.kiosk_id) {
        if names.contains_key(id) {
            continue;
        }
        if let Some(k) = assets::get_kiosk_by_id(env, id).await? {
            names.insert(id.clone(), k.name);
        }
    }

    let data = ProfileData {
        lang,
        user,
        reports: report_rows
            .into_iter()
            .map(|r| ProfileReport {
                kiosk_name: names
                    .get(&r.kiosk_id)
                    .cloned()
                    .unwrap_or_else(|| r.kiosk_id.clone()),
                id: r.id,
                kiosk_id: r.kiosk_id,
                kind: r.kind,
                status: r.status,
                pr_url: r.pr_url,
                created_at: r.created_at as i64,
            })
            .collect(),
        submissions: submission_rows
            .into_iter()
            .map(|s| ProfileSubmission {
                id: s.id,
                payload: s.payload,
                status: s.status,
                pr_url: s.pr_url,
                created_at: s.created_at as i64,
            })
            .collect(),
        ratings_count: ratings_count.map(|c| c.n).unwrap_or(0),
        checkins_count: checkins_count.map(|c| c.n).unwrap_or(0),
        signals_count: signals_count.map(|c| c.n).unwrap_or(0),
        can_rename: username_row.and_then(|c| c.changed_at).is_none(),
        reported_flag: query_get(q, "reported").map(str::to_owned),
        submitted_flag: query_get(q, "submitted").map(str::to_owned),
        username_flag: query_get(q, "username").map(str::to_owned),
        link_flag: query_get(q, "link").map(str::to_owned),
        delete_flag: query_get(q, "delete").map(str::to_owned),
    };
    let (body, meta) = trinkhallen_ui::pages::account::profile(&data);
    page(state, meta, body)
}

/// Change-once username. Validation + UNIQUE + the one-change guard all live
/// in the SQL layer; the form only renders while the rename is available.
async fn me_username(mut req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let me = path_for_lang("/me", state.lang);
    let Some(user) = &state.user else {
        return redirect(&me, 302, &[]);
    };
    let form = req.form_data().await?;
    let raw = form.get_field("username").unwrap_or_default();
    let result = users::rename_username(&env.d1("DB")?, &user.id, &raw).await?;
    redirect(&format!("{me}?username={}", result.code()), 302, &[])
}

/// Account deletion. Hard-cascades personal data; anonymises contributions
/// that already shipped to trinkhallen-data so the merged PRs stay intact but
/// the link back to the real person is severed.
async fn me_delete(mut req: Request, env: &Env, state: &RequestState) -> Result<Response> {
    let lang = state.lang;
    let me = path_for_lang("/me", lang);
    let Some(user) = &state.user else {
        return redirect(&me, 302, &[]);
    };
    let form = req.form_data().await?;
    if form.get_field("confirm").as_deref() != Some("yes") {
        return redirect(&format!("{me}?delete=unconfirmed"), 302, &[]);
    }
    users::delete_account(&env.d1("DB")?, &user.id, &user.email).await?;
    let clearing = crate::session::destroy_session(&req, env).await?;
    // Purge the SW runtime cache before the client navigates, same trick as
    // logout — otherwise the cached logged-in shell flashes back.
    redirect(
        &format!("{}?deleted=ok", path_for_lang("/", lang)),
        302,
        &[clearing],
    )
}

// ── /moderate ───────────────────────────────────────────────────────────────

async fn moderate_page(
    env: &Env,
    state: &RequestState,
    q: &[(String, String)],
) -> Result<Response> {
    if let Some(res) = crate::moderation::require_moderator(state) {
        return Ok(res);
    }
    let user = state
        .user
        .as_ref()
        .expect("require_moderator admits only signed-in moderators");
    let lang = state.lang;
    let tab = match query_get(q, "tab").unwrap_or("submissions") {
        "reports" => ModTab::Reports,
        "users" => ModTab::Users,
        "anomalies" => ModTab::Anomalies,
        _ => ModTab::Submissions,
    };

    #[derive(serde::Deserialize)]
    struct SubmissionRow {
        id: String,
        payload: String,
        created_at: f64,
        user_username: Option<String>,
        user_email: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct ReportRow {
        id: String,
        kiosk_id: String,
        kind: String,
        payload: Option<String>,
        created_at: f64,
        user_username: Option<String>,
        user_email: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct UserRow {
        id: String,
        email: String,
        username: Option<String>,
        role: String,
        banned_at: Option<f64>,
        created_at: f64,
        ratings_count: u64,
        reports_count: u64,
        submissions_count: u64,
        checkins_count: u64,
    }
    #[derive(serde::Deserialize)]
    struct AnomalyRow {
        id: String,
        user_id: String,
        kind: String,
        payload: Option<String>,
        created_at: f64,
        user_username: Option<String>,
        user_email: Option<String>,
    }

    let db = env.d1("DB")?;
    let sentinel = [db::Arg::Text(users::DELETED_USER_SENTINEL)];
    let (submissions, reports, users_rows, anomalies) = futures_util::try_join!(
        db::rows::<SubmissionRow>(
            &db,
            "SELECT s.id, s.payload, s.created_at, u.username AS user_username, u.email AS user_email
         FROM submissions s LEFT JOIN users u ON u.id = s.user_id
         WHERE s.status = 'pending' ORDER BY s.created_at ASC LIMIT 100",
            &[],
        ),
        db::rows::<ReportRow>(
            &db,
            "SELECT r.id, r.kiosk_id, r.kind, r.payload, r.created_at,
              u.username AS user_username, u.email AS user_email
         FROM reports r
         LEFT JOIN users u ON u.id = r.user_id
         WHERE r.status = 'open' ORDER BY r.created_at ASC LIMIT 100",
            &[],
        ),
        db::rows::<UserRow>(
            &db,
            "SELECT
          u.id, u.email, u.username, u.role,
          u.banned_at, u.created_at,
          (SELECT COUNT(*) FROM ratings    r WHERE r.user_id = u.id) AS ratings_count,
          (SELECT COUNT(*) FROM reports    r WHERE r.user_id = u.id) AS reports_count,
          (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id) AS submissions_count,
          (SELECT COUNT(*) FROM checkins   c WHERE c.user_id = u.id) AS checkins_count
         FROM users u
         WHERE u.id != ?
         ORDER BY u.banned_at IS NULL ASC, u.created_at DESC
         LIMIT 200",
            &sentinel,
        ),
        db::rows::<AnomalyRow>(
            &db,
            "SELECT a.id, a.user_id, a.kind, a.payload, a.created_at,
              u.username AS user_username, u.email AS user_email
         FROM user_anomalies a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.reviewed_at IS NULL
         ORDER BY a.created_at DESC
         LIMIT 100",
            &[],
        ),
    )?;

    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for id in reports.iter().map(|r| &r.kiosk_id) {
        if names.contains_key(id) {
            continue;
        }
        if let Some(k) = assets::get_kiosk_by_id(env, id).await? {
            names.insert(id.clone(), k.name);
        }
    }

    let data = ModerateData {
        lang,
        role: user.role,
        tab,
        submissions: submissions
            .into_iter()
            .map(|s| ModSubmission {
                id: s.id,
                payload: s.payload,
                created_at: s.created_at as i64,
                user_username: s.user_username,
                user_email: s.user_email,
            })
            .collect(),
        reports: reports
            .into_iter()
            .map(|r| ModReport {
                kiosk_name: names
                    .get(&r.kiosk_id)
                    .cloned()
                    .unwrap_or_else(|| r.kiosk_id.clone()),
                id: r.id,
                kiosk_id: r.kiosk_id,
                kind: r.kind,
                payload: r.payload,
                created_at: r.created_at as i64,
                user_username: r.user_username,
                user_email: r.user_email,
            })
            .collect(),
        users: users_rows
            .into_iter()
            .map(|u| ModUser {
                id: u.id,
                email: u.email,
                username: u.username,
                role: Role::parse(&u.role),
                banned_at: u.banned_at.map(|t| t as i64),
                created_at: u.created_at as i64,
                ratings_count: u.ratings_count,
                reports_count: u.reports_count,
                submissions_count: u.submissions_count,
                checkins_count: u.checkins_count,
            })
            .collect(),
        anomalies: anomalies
            .into_iter()
            .map(|a| ModAnomaly {
                id: a.id,
                user_id: a.user_id,
                kind: a.kind,
                payload: a.payload,
                created_at: a.created_at as i64,
                user_username: a.user_username,
                user_email: a.user_email,
            })
            .collect(),
    };
    let (body, meta) = trinkhallen_ui::pages::moderate::render(&data);
    page(state, meta, body)
}
