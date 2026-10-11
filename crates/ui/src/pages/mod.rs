//! Page bodies (`<main>` content). Each page is `fn(&Data) -> String` — the
//! Worker loads `Data` and wraps the result with [`crate::render::document`],
//! taking `title`/`description`/`json_ld`/flags from [`PageMeta`].
//!
//! Contract between the ui and worker crates: these structs are the only data
//! the pages see.

use serde::{Deserialize, Serialize};
use trinkhallen_core::filters::KioskFilter;
use trinkhallen_core::geo::{Bbox, LatLng};
use trinkhallen_core::{KioskRecord, Lang};

use crate::model::*;
use crate::render::ClientEntry;

pub mod about;
pub mod account;
pub mod add;
pub mod city;
pub mod jetzt;
pub mod kiosk;
pub mod legal;
pub mod map;
pub mod moderate;
pub mod panel;

/// Head metadata a page wants; the Worker copies it into `render::Page`.
#[derive(Debug, Clone, Default)]
pub struct PageMeta {
    pub title: Option<String>,
    pub description: Option<String>,
    pub canonical_url: Option<String>,
    pub noindex: bool,
    pub json_ld: Vec<serde_json::Value>,
    pub entries: Vec<ClientEntry>,
    pub full_bleed: bool,
    pub nav: Option<Nav>,
}

/// Side-panel list; also the `/api/kiosks/panel` fragment.
#[derive(Debug, Clone)]
pub struct PanelData<'a> {
    pub lang: Lang,
    /// Already filtered + sorted; the component renders at most these.
    pub kiosks: Vec<&'a KioskRecord>,
    pub total_in_bbox: usize,
    pub filtered_count: usize,
    pub open_now_count: Option<usize>,
    pub filter_active: bool,
    pub reset_href: Option<String>,
    pub origin: Option<LatLng>,
    pub user_agent: Option<String>,
}

/// `/` and the map view. `focused` = the sheet is
/// pre-opened with that kiosk's detail HTML (`inner_html`).
#[derive(Debug, Clone)]
pub struct MapData<'a> {
    pub lang: Lang,
    pub filter: KioskFilter,
    /// `?…` of the request, for `data-filter-state`.
    pub search: String,
    pub focused: Option<FocusedKiosk<'a>>,
    pub initial_bbox: Option<Bbox>,
    pub panel: PanelData<'a>,
}

#[derive(Debug, Clone)]
pub struct FocusedKiosk<'a> {
    pub kiosk: &'a KioskRecord,
    pub inner_html: String,
    /// The `/k/:id` href in the active locale (`data-initial-href`).
    pub href: String,
}

/// Kiosk detail (+ rating block, report form, check-in form).
#[derive(Debug, Clone)]
pub struct KioskDetailData<'a> {
    pub lang: Lang,
    pub kiosk: &'a KioskRecord,
    pub user_agent: Option<String>,
    pub aggregate: Aggregate,
    pub own_rating: Option<RatingRow>,
    pub rating_comments: Vec<RatingComment>,
    pub is_logged_in: bool,
    pub nearby: Vec<NearbyKiosk>,
    pub user_reports: Vec<UserKioskReport>,
    /// Today is a public holiday in the kiosk's Bundesland (PH banner).
    pub is_public_holiday: bool,
    pub now_unix: i64,
}

/// `/stadt/:slug`.
#[derive(Debug, Clone)]
pub struct CityData<'a> {
    pub lang: Lang,
    pub slug: String,
    pub city: String,
    pub total: usize,
    pub open_now: usize,
    /// First 100, name-sorted.
    pub visible: Vec<&'a KioskRecord>,
    pub map_href: String,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct AboutData {
    pub lang: Lang,
    pub total: usize,
    pub ratings: u64,
    pub users: u64,
}

/// `/add` form.
#[derive(Debug, Clone)]
pub struct AddData {
    pub lang: Lang,
    pub initial_lat: String,
    pub initial_lng: String,
    pub error: Option<String>,
}

/// `/me` logged out (login page).
#[derive(Debug, Clone)]
pub struct LoginData {
    pub lang: Lang,
    /// `?magic=` flag (`sent` | `invalid` | `expired` | `robot`).
    pub magic: Option<String>,
    pub turnstile_site_key: Option<String>,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileReport {
    pub id: String,
    pub kiosk_id: String,
    pub kiosk_name: String,
    pub kind: String,
    pub status: String,
    pub pr_url: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileSubmission {
    pub id: String,
    /// Raw JSON payload as stored (`properties.name` is shown).
    pub payload: String,
    pub status: String,
    pub pr_url: Option<String>,
    pub created_at: i64,
}

/// `/me` logged in (`renderProfile`).
#[derive(Debug, Clone)]
pub struct ProfileData {
    pub lang: Lang,
    pub user: SessionUser,
    pub reports: Vec<ProfileReport>,
    pub submissions: Vec<ProfileSubmission>,
    pub ratings_count: u64,
    pub checkins_count: u64,
    pub signals_count: u64,
    pub can_rename: bool,
    pub reported_flag: Option<String>,
    pub submitted_flag: Option<String>,
    pub username_flag: Option<String>,
    pub link_flag: Option<String>,
    pub delete_flag: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ModTab {
    Submissions,
    Reports,
    Users,
    Anomalies,
}

#[derive(Debug, Clone)]
pub struct ModSubmission {
    pub id: String,
    pub payload: String,
    pub created_at: i64,
    pub user_username: Option<String>,
    pub user_email: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ModReport {
    pub id: String,
    pub kiosk_id: String,
    pub kiosk_name: String,
    pub kind: String,
    pub payload: Option<String>,
    pub created_at: i64,
    pub user_username: Option<String>,
    pub user_email: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ModUser {
    pub id: String,
    pub email: String,
    pub username: Option<String>,
    pub role: Role,
    pub banned_at: Option<i64>,
    pub created_at: i64,
    pub ratings_count: u64,
    pub reports_count: u64,
    pub submissions_count: u64,
    pub checkins_count: u64,
}

#[derive(Debug, Clone)]
pub struct ModAnomaly {
    pub id: String,
    pub user_id: String,
    pub kind: String,
    pub payload: Option<String>,
    pub created_at: i64,
    pub user_username: Option<String>,
    pub user_email: Option<String>,
}

/// `/moderate`.
#[derive(Debug, Clone)]
pub struct ModerateData {
    pub lang: Lang,
    pub role: Role,
    pub tab: ModTab,
    pub submissions: Vec<ModSubmission>,
    pub reports: Vec<ModReport>,
    pub users: Vec<ModUser>,
    pub anomalies: Vec<ModAnomaly>,
}
