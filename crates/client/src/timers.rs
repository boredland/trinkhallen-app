//! Timers and viewport helpers the behaviour modules share.

use std::cell::Cell;
use std::rc::Rc;

/// Trailing-edge debounce. Dropping the handle cancels a pending call.
pub struct Debounce {
    id: Cell<Option<i32>>,
    ms: i32,
}

impl Debounce {
    pub fn new(ms: i32) -> Rc<Self> {
        Rc::new(Debounce {
            id: Cell::new(None),
            ms,
        })
    }

    pub fn schedule(self: &Rc<Self>, f: impl FnOnce() + 'static) {
        self.cancel();
        let this = Rc::clone(self);
        self.id.set(Some(crate::dom::set_timeout_id(
            move || {
                this.id.set(None);
                f();
            },
            self.ms,
        )));
    }

    pub fn cancel(&self) {
        if let Some(id) = self.id.replace(None) {
            crate::dom::clear_timeout(id);
        }
    }
}

/// `matchMedia("(min-width: 640px)")` — the desktop breakpoint the sheet and
/// map padding rules key off.
pub fn is_desktop() -> bool {
    crate::dom::match_media("(min-width: 640px)")
}
