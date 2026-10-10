//! Mobile drag-to-dismiss for bottom-anchored panels.
//!
//! Shared by the kiosk sheet (drag down to close) and the filter sidebar (drag
//! down to collapse). Pointer drag on `handle` translates `target` downward;
//! releasing past `threshold` × the measured height fires the dismiss
//! callback, otherwise the panel springs back. Desktop (≥640px) is a no-op.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use wasm_bindgen::JsCast;

use crate::dom;
use crate::timers;

/// `Element.style` lives on `HtmlElement`; every draggable panel is one.
fn style_of(el: &web_sys::Element) -> web_sys::CssStyleDeclaration {
    el.clone().unchecked_into::<web_sys::HtmlElement>().style()
}

pub struct Opts {
    /// The grab handle the user drags.
    pub handle: web_sys::Element,
    /// Element that receives the translateY transform during the drag.
    pub target: web_sys::Element,
    /// Element whose height sets the dismiss distance; defaults to `target`.
    pub measure: Option<web_sys::Element>,
    /// Fraction of the measured height past which release dismisses.
    pub threshold: f64,
    pub on_dismiss: Box<dyn FnMut()>,
}

pub fn install(opts: Opts) {
    let Opts {
        handle,
        target,
        measure,
        threshold,
        on_dismiss,
    } = opts;
    let measure = measure.unwrap_or_else(|| target.clone());

    let start_y = Rc::new(Cell::new(0.0));
    let last_dy = Rc::new(Cell::new(0.0));
    let dragging = Rc::new(Cell::new(false));
    let on_dismiss = Rc::new(RefCell::new(on_dismiss));

    {
        let (start_y, last_dy, dragging) = (
            Rc::clone(&start_y),
            Rc::clone(&last_dy),
            Rc::clone(&dragging),
        );
        let (target, drag_handle) = (target.clone(), handle.clone());
        let on_down = dom::js_closure(move |e: web_sys::PointerEvent| {
            if timers::is_desktop() {
                return;
            }
            dragging.set(true);
            start_y.set(e.client_y() as f64);
            last_dy.set(0.0);
            let _ = drag_handle.set_pointer_capture(e.pointer_id());
            style_of(&target).set_property("transition", "none").ok();
        });
        handle
            .add_event_listener_with_callback("pointerdown", on_down.as_ref().unchecked_ref())
            .ok();
        on_down.forget();
    }

    {
        let (last_dy, dragging) = (Rc::clone(&last_dy), Rc::clone(&dragging));
        let (start_y, target) = (Rc::clone(&start_y), target.clone());
        let on_move = dom::js_closure(move |e: web_sys::PointerEvent| {
            if !dragging.get() {
                return;
            }
            last_dy.set(0f64.max(e.client_y() as f64 - start_y.get()));
            style_of(&target)
                .set_property("transform", &format!("translateY({}px)", last_dy.get()))
                .ok();
        });
        handle
            .add_event_listener_with_callback("pointermove", on_move.as_ref().unchecked_ref())
            .ok();
        on_move.forget();
    }

    for name in ["pointerup", "pointercancel"] {
        let cancelled = name == "pointercancel";
        let (dragging, last_dy, on_dismiss) = (
            Rc::clone(&dragging),
            Rc::clone(&last_dy),
            Rc::clone(&on_dismiss),
        );
        let (target, measure) = (target.clone(), measure.clone());
        let end = dom::js_closure(move |_e: web_sys::PointerEvent| {
            if !dragging.get() {
                return;
            }
            dragging.set(false);
            style_of(&target).set_property("transition", "").ok();
            style_of(&target).set_property("transform", "").ok();
            let height = measure.get_bounding_client_rect().height();
            let height = if height > 0.0 { height } else { 600.0 };
            if !cancelled && last_dy.get() > height * threshold {
                (on_dismiss.borrow_mut())();
            }
        });
        handle
            .add_event_listener_with_callback(name, end.as_ref().unchecked_ref())
            .ok();
        end.forget();
    }
}
