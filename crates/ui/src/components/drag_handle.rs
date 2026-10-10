//! The mobile grab bar shared by the kiosk sheet and the filter sidebar.

use dioxus::prelude::*;

/// Marked `data-drag-handle` so the client wires the same drag gesture to
/// either panel. Hidden on desktop, where both panels dock to an edge and use
/// a button instead.
#[component]
pub fn DragHandle(label: String) -> Element {
    rsx! {
        button {
            r#type: "button",
            "data-drag-handle": "",
            aria_label: "{label}",
            class: "flex w-full cursor-grab touch-none items-center justify-center bg-surface py-2 sm:hidden",
            span { class: "block h-1 w-10 rounded-full bg-border-hi" }
        }
    }
}
