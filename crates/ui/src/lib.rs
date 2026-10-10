//! Dioxus components for trinkhallen.app.
//!
//! Pure presentation: props in, `Element` out, no I/O. The Worker renders
//! these to HTML; the client crate hydrates the [`islands`] in the browser.
//! Markup (classes, ids, `data-*` hooks, form field names) mirrors the TS
//! app so CSS, the service worker and existing deep links keep working.

pub mod components;
pub mod islands;
pub mod model;
pub mod pages;
pub mod render;

pub use model::*;
