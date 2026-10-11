//! Domain logic for trinkhallen.app that has no I/O: shared verbatim by the
//! Cloudflare Worker (SSR + API), the hydrated browser islands and the
//! build-time importer, so a rule (what counts as "open", how a filter
//! matches, which region owns a coordinate) has exactly one definition.

pub mod filters;
pub mod geo;
pub mod hours;
pub mod i18n;
pub mod kind;
pub mod navigate;
pub mod record;
pub mod regions;
pub mod reports;
pub mod tags;
pub mod usernames;

pub use i18n::Lang;
pub use record::KioskRecord;

/// Canonical public origin; used for canonical URLs, JSON-LD and the sitemap.
pub const ORIGIN: &str = "https://trinkhallen.app";
