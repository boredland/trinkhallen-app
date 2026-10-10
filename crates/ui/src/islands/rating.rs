//! `rating` island: `RatingBlock.tsx` + `src/client/rating.ts`.
//!
//! The markup is exactly `RatingBlock`, wrapped by the island root that
//! [`crate::render::island`] emits (`#rating-block[data-island]`). The
//! fragment returned by `POST /api/ratings` with `X-Tk-Fragment: 1` is the
//! same wrapper — rendered by [`crate::pages::kiosk::rating_block`] — so a
//! swap keeps a `#rating-block` in the DOM for the next round.

use dioxus::prelude::*;
use serde::{Deserialize, Serialize};
use trinkhallen_core::i18n::{Lang, path_for_lang, t, tpl};

use crate::components::shared::fmt_date;
use crate::model::{Aggregate, RatingComment, RatingRow};

pub const NAME: &str = "rating";

#[derive(Props, Clone, PartialEq, Serialize, Deserialize)]
pub struct RatingProps {
    pub lang: Lang,
    pub kiosk_id: String,
    pub aggregate: Aggregate,
    pub own: Option<RatingRow>,
    pub comments: Vec<RatingComment>,
    pub is_logged_in: bool,
}

impl RatingProps {
    pub fn new(
        lang: Lang,
        kiosk_id: &str,
        aggregate: Aggregate,
        own: Option<RatingRow>,
        comments: &[RatingComment],
        is_logged_in: bool,
    ) -> Self {
        RatingProps {
            lang,
            kiosk_id: kiosk_id.to_owned(),
            aggregate,
            own,
            comments: comments.to_vec(),
            is_logged_in,
        }
    }

    #[cfg(test)]
    pub fn sample() -> Self {
        RatingProps::new(Lang::De, "tk_fr_1", Aggregate::default(), None, &[], true)
    }
}

/// Pre-rendered island wrapper: `<div id="rating-block" data-island="rating"
/// data-props=…>…</div>`. Also the body of the `/api/ratings` fragment.
pub fn render_fragment(props: &RatingProps) -> String {
    crate::render::island("rating-block", NAME, RatingIsland, props.clone())
}

#[allow(non_snake_case)]
pub fn RatingIsland(props: RatingProps) -> Element {
    let stars = use_signal(|| props.own.as_ref().map(|o| o.stars).unwrap_or(0));
    let mut comment = use_signal(|| {
        props
            .own
            .as_ref()
            .and_then(|o| o.comment.clone())
            .unwrap_or_default()
    });
    let error = use_signal(String::new);
    let busy = use_signal(|| false);

    let lang = props.lang;
    let own_stars = props.own.as_ref().map(|o| o.stars).unwrap_or(0);
    let kiosk_id = props.kiosk_id.clone();
    let form_heading = if props.own.is_some() {
        t(lang, "rating.yours")
    } else {
        t(lang, "rating.rate")
    };
    let submit_label = if props.own.is_some() {
        format!("▶ {}", t(lang, "rating.update"))
    } else {
        format!("▶ {}", t(lang, "rating.submit"))
    };

    rsx! {
        div { class: "space-y-5",
            {aggregate_view(lang, &props.aggregate)}
            {comments_list(lang, &props.comments)}
            if props.is_logged_in {
                form {
                    action: "/api/ratings",
                    method: "post",
                    class: "space-y-3 border-t-2 border-border pt-4",
                    "data-rating-form": "",
                    onsubmit: {
                        let lang = lang;
                        let kiosk_id = kiosk_id.clone();
                        move |evt: FormEvent| {
                            evt.prevent_default();
                            dioxus::prelude::spawn(submit_rating(
                                lang,
                                kiosk_id.clone(),
                                stars,
                                comment,
                                error,
                                busy,
                                false,
                            ));
                        }
                    },
                    input { r#type: "hidden", name: "kiosk_id", value: "{kiosk_id}" }
                    p { class: "font-display text-sm tracking-wider uppercase text-fg-muted",
                        "{form_heading}"
                    }
                    {stars_group(lang, own_stars, stars)}
                    p {
                        "data-rating-error": "",
                        hidden: error.read().is_empty(),
                        class: "text-sm text-danger",
                        aria_live: "polite",
                        "{error}"
                    }
                    label { class: "block",
                        span { class: "sr-only", "{t(lang, \"rating.commentSr\")}" }
                        textarea {
                            name: "comment",
                            rows: "2",
                            maxlength: "500",
                            placeholder: "{t(lang, \"rating.commentPlaceholder\")}",
                            class: "w-full border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:border-neon-pink focus:outline-none",
                            // `value`, not a text child: the browser owns a
                            // textarea's text once it's edited, so a child
                            // text node would be gone when dioxus patches it.
                            value: "{comment}",
                            oninput: move |evt| comment.set(evt.value()),
                        }
                    }
                    div { class: "flex flex-wrap gap-2",
                        button {
                            r#type: "submit",
                            class: "btn-neon",
                            disabled: busy.read().clone(),
                            "{submit_label}"
                        }
                        if props.own.is_some() {
                            button {
                                r#type: "button",
                                class: "cursor-pointer border-2 border-border-hi px-3 py-1.5 font-display text-sm tracking-wider uppercase text-fg-muted hover:border-danger hover:text-danger",
                                onclick: {
                                    let lang = lang;
                                    let kiosk_id = kiosk_id.clone();
                                    move |_| {
                                        dioxus::prelude::spawn(submit_rating(
                                            lang,
                                            kiosk_id.clone(),
                                            stars,
                                            comment,
                                            error,
                                            busy,
                                            true,
                                        ));
                                    }
                                },
                                "{t(lang, \"rating.delete\")}"
                            }
                        }
                    }
                }
            } else {
                {logged_out_cta(lang)}
            }
        }
    }
}

/// POST `/api/ratings` (or its `/delete`) and swap `#rating-block`, exactly
/// like `src/client/rating.ts`: validate stars first, disable the buttons,
/// swap the returned fragment on success.
async fn submit_rating(
    lang: Lang,
    kiosk_id: String,
    stars: Signal<u8>,
    comment: Signal<String>,
    mut error: Signal<String>,
    mut busy: Signal<bool>,
    is_delete: bool,
) {
    if !is_delete && *stars.peek() < 1 {
        error.set(t(lang, "client.rating.pickStars"));
        if let Some(b) = crate::islands::browser() {
            b.0.scroll_into_view("[data-stars-group]");
        }
        return;
    }
    error.set(String::new());
    busy.set(true);
    let fields = if is_delete {
        vec![("kiosk_id".to_string(), kiosk_id)]
    } else {
        vec![
            ("kiosk_id".to_string(), kiosk_id),
            ("stars".to_string(), stars.peek().to_string()),
            ("comment".to_string(), comment.peek().clone()),
        ]
    };
    let url = if is_delete {
        "/api/ratings/delete"
    } else {
        "/api/ratings"
    };
    let Some(b) = crate::islands::browser() else {
        busy.set(false);
        return;
    };
    match b.0.post_form(url, fields).await {
        Ok(res) if res.status < 300 => {
            // rating.ts swaps `#rating-block` via outerHTML: the fragment
            // carries its own root with that id, so the next swap still works.
            b.0.set_outer_html("rating-block", &res.body);
            return;
        }
        Ok(res) => {
            error.set(if res.status == 401 {
                t(lang, "client.rating.loginToRate")
            } else {
                t(lang, "client.rating.saveFailed")
            });
        }
        Err(_) => error.set(t(lang, "client.errNetwork")),
    }
    busy.set(false);
}

fn aggregate_view(lang: Lang, aggregate: &Aggregate) -> Element {
    if aggregate.count == 0 {
        return rsx! { p { class: "text-fg-muted", "{t(lang, \"rating.noneYet\")}" } };
    }
    let avg = format!("{:.1}", aggregate.avg);
    let count_label = {
        let suffix = if aggregate.count == 1 {
            ""
        } else if lang == Lang::En {
            "s"
        } else {
            "en"
        };
        tpl(
            lang,
            "rating.count",
            &[("n", &aggregate.count), ("suffix", &suffix)],
        )
    };
    rsx! {
        div { class: "flex flex-col gap-3 sm:flex-row sm:items-center",
            div { class: "font-display text-fg",
                span { class: "text-4xl text-neon-amber", "{avg}" }
                span { class: "ml-1 text-sm text-fg-muted", "/ 5" }
                p { class: "text-sm text-fg-dim", "{count_label}" }
            }
            ul { class: "flex-1 space-y-0.5",
                for star in (1..=5).rev() {
                    {
                        let n = aggregate.histogram[star - 1];
                        let pct = if aggregate.count == 0 {
                            0
                        } else {
                            ((n as f64 / aggregate.count as f64) * 100.0).round() as i64
                        };
                        rsx! {
                            li { class: "flex items-center gap-2 text-xs text-fg-dim",
                                span { class: "w-3 text-fg-muted", "{star}" }
                                span { class: "relative h-2 flex-1 overflow-hidden border border-border bg-bg",
                                    span {
                                        class: "absolute inset-y-0 left-0 bg-neon-amber",
                                        style: format!("width: {pct}%"),
                                    }
                                }
                                span { class: "w-8 text-right tabular-nums", "{n}" }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn comments_list(lang: Lang, comments: &[RatingComment]) -> Element {
    if comments.is_empty() {
        return rsx! {};
    }
    rsx! {
        ul { class: "space-y-3 border-t-2 border-border pt-4",
            for c in comments {
                li { class: "space-y-1",
                    div { class: "flex flex-wrap items-center gap-x-2 text-sm",
                        span {
                            aria_label: "{tpl(lang, \"rating.starsOfFive\", &[(\"n\", &c.stars)])}",
                            span { class: "text-neon-amber", {"★".repeat(c.stars as usize)} }
                            span { class: "text-fg-dim", {"★".repeat(5 - c.stars as usize)} }
                        }
                        span { class: "font-display text-xs tracking-wider uppercase text-fg-muted", "{c.author}" }
                        span { class: "ml-auto text-xs text-fg-dim", "{fmt_date(c.updated_at, lang)}" }
                    }
                    p { class: "whitespace-pre-line text-sm text-fg", "{c.comment}" }
                }
            }
        }
    }
}

fn stars_group(lang: Lang, own_stars: u8, mut stars: Signal<u8>) -> Element {
    rsx! {
        div {
            role: "radiogroup",
            aria_label: "{t(lang, \"rating.starsAria\")}",
            class: "flex items-center gap-1 text-2xl",
            "data-stars-group": "",
            for star in 1..=5u8 {
                {
                    // `read()` (not `peek`) so the group subscribes and the
                    // amber/dim classes repaint the moment a star is picked —
                    // the TS `paintStars` repaint.
                    let active = star <= *stars.read();
                    let cls = if active {
                        "transition-colors text-neon-amber"
                    } else {
                        "transition-colors text-fg-dim hover:text-neon-amber/60"
                    };
                    let label = tpl(lang, "rating.nStars", &[("n", &star)]);
                    rsx! {
                        label { class: "cursor-pointer",
                            // No `required`: these radios are sr-only, so an
                            // unfilled-required submit blocks natively but the
                            // validation bubble can't render off-screen. We
                            // validate star selection on submit instead.
                            input {
                                r#type: "radio",
                                name: "stars",
                                value: "{star}",
                                checked: active && star == own_stars,
                                class: "sr-only",
                                onchange: move |_| stars.set(star),
                            }
                            span {
                                aria_hidden: "true",
                                class: "{cls}",
                                "data-star-value": "{star}",
                                "★"
                            }
                            span { class: "sr-only", "{label}" }
                        }
                    }
                }
            }
        }
    }
}

fn logged_out_cta(lang: Lang) -> Element {
    let href = path_for_lang("/me", lang);
    rsx! {
        div { class: "border-t-2 border-border pt-4 text-sm text-fg-muted",
            a { href: "{href}", class: "text-neon-cyan underline underline-offset-2", "{t(lang, \"auth.login\")}" }
            "{t(lang, \"rating.loginToRateTail\")}"
        }
    }
}
