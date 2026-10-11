//! Static (server-rendered, non-hydrated) components.
//!
//! The submodules that no page imports directly still live here rather than
//! inside the pages that use them: `pages::kiosk` embeds them into the sheet
//! partial (`?partial=1`) as well as the standalone page, and
//! `pages::kiosk::rating_block` renders `RatingBlock` for the
//! `X-Tk-Fragment: 1` swap.

pub mod layout;
pub mod shared;

pub mod drag_handle;
pub mod kiosk_detail;
pub mod kiosk_list;
pub mod legal_prose;

pub use shared::{
    city_display_name, city_slug, fmt_date, format_locale, homepage_json_ld,
    kiosk_breadcrumb_json_ld, kiosk_description, kiosk_headline, kiosk_json_ld,
};
