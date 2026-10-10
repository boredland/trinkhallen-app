//! Browser half of the port.
//!
//! Loaded once per document from the `<head>` (`import init from client.js`).
//! It hydrates every server-rendered island and then wires up the plain-DOM
//! behaviour the TS bundle (`src/client/app.entry.ts`) used to own: theme,
//! sidebar, kiosk sheet, filter chip form, panel refresh, logout, service
//! worker, install prompt, and the MapLibre bridge (`web/map.js`).

#![allow(clippy::too_many_arguments)]

mod dom;
mod drag;
mod forms;
mod geo;
mod install;
mod islands_bridge;
mod map_data;
mod map_glue;
mod net;
mod sheet;
mod startup;
mod sw;
mod theme;
mod timers;

pub use startup::start;
