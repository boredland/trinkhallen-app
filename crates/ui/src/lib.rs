//! Dioxus components for trinkhallen.app.
//!
//! Pure presentation: props in, `Element` out, no I/O. The Worker renders
//! these to HTML; the client crate hydrates the [`islands`] in the browser.
//! Markup (classes, ids, `data-*` hooks, form field names) is a contract with
//! the CSS, the service worker and existing deep links.

pub mod components;
pub mod islands;
pub mod model;
pub mod pages;
pub mod render;

pub use model::*;
