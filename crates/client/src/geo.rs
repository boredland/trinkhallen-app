//! Best-effort geolocation for the check-in island.

use std::future::Future;

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;
use wasm_bindgen_futures::JsFuture;
use web_sys::PositionOptions;

use trinkhallen_ui::islands::Coords;

/// `src/client/checkin.ts`'s `tryGeolocate`: high accuracy, 3500 ms browser
/// timeout, a 4000 ms hard cap, and a 60 s position cache. Denial, timeout and
/// "no geolocation API" all resolve to `None` — the caller treats "no fix" as
/// a silent best-effort miss, never an error.
///
/// The position object is read field by field: web-sys types the Geolocation
/// API behind `web_sys_unstable_apis`, which the build does not set.
pub async fn geolocate() -> Option<Coords> {
    let nav = crate::dom::window().navigator();
    let geo = nav.geolocation().ok()?;
    let opts = PositionOptions::new();
    opts.set_enable_high_accuracy(true);
    opts.set_timeout(3500);
    opts.set_maximum_age(60_000);

    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let resolved = resolve.clone();
        let on_ok = Closure::once_into_js(move |pos: JsValue| {
            let coords = crate::dom::read_property(&pos, "coords");
            let fix = crate::dom::read_number(&coords, "latitude")
                .zip(crate::dom::read_number(&coords, "longitude"));
            let detail = match fix {
                Some((lat, lng)) => js_sys::JSON::parse(
                    &serde_json::json!({
                        "lat": lat,
                        "lng": lng,
                        "accuracy": crate::dom::read_number(&coords, "accuracy").unwrap_or(0.0),
                    })
                    .to_string(),
                )
                .unwrap_or(JsValue::NULL),
                None => JsValue::NULL,
            };
            let _ = resolved.call1(&JsValue::NULL, &detail);
        });
        let rejected = resolve.clone();
        let on_err = Closure::once_into_js(move |_e: JsValue| {
            let _ = rejected.call0(&JsValue::NULL);
        });
        let _ = geo.get_current_position_with_error_callback_and_options(
            on_ok.as_ref().unchecked_ref(),
            Some(on_err.as_ref().unchecked_ref()),
            &opts,
        );
    });

    let (timeout_tx, timeout_rx) = futures_channel::oneshot::channel();
    crate::dom::set_timeout(
        move || {
            let _ = timeout_tx.send(());
        },
        4000,
    );

    let timed = race(JsFuture::from(promise), async {
        let _ = timeout_rx.await;
    })
    .await?;
    let fix = timed.ok()?;
    if fix.is_null() {
        return None;
    }
    Some(Coords {
        lat: crate::dom::read_number(&fix, "lat")?,
        lng: crate::dom::read_number(&fix, "lng")?,
        accuracy: crate::dom::read_number(&fix, "accuracy").unwrap_or(0.0),
    })
}

/// First of the two futures to settle wins; the loser is dropped.
async fn race<T>(a: impl Future<Output = T>, b: impl Future<Output = ()>) -> Option<T> {
    use futures_util::FutureExt;
    let (a, b) = (a.fuse(), b.fuse());
    futures_util::pin_mut!(a, b);
    futures_util::select! {
        v = a => Some(v),
        _ = b => None,
    }
}
