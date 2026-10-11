//! `GET /add`: the "Späti vorschlagen" form with its pick map.

use dioxus::prelude::*;
use trinkhallen_core::i18n::{path_for_lang, t, tag_label};

use crate::model::Nav;
use crate::pages::{AddData, PageMeta};
use crate::render::{ClientEntry, to_html};

/// Checkbox tags of the suggestion form.
const TAGS: [&str; 12] = [
    "snacks",
    "bier",
    "kaffee",
    "eis",
    "zeitungen",
    "gluecksspiele",
    "wc",
    "sitzgelegenheiten",
    "innenraum",
    "draussen",
    "barrierefrei",
    "automat",
];

const PAYMENT_KEYS: [&str; 4] = ["cash", "cards", "contactless", "girocard"];

const INPUT_CLS: &str = "border-2 border-border-hi bg-surface-2 px-2 py-1.5 text-fg focus:border-neon-pink focus:outline-none";

pub fn render(data: &AddData) -> (String, PageMeta) {
    let lang = data.lang;
    let body = to_html(rsx! {
        header { class: "mb-6",
            h1 { class: "font-display text-4xl tracking-wide text-fg", "{t(lang, \"add.heading\")}" }
            p { class: "mt-2 text-fg-muted", "{t(lang, \"add.intro\")}" }
        }

        if let Some(error) = &data.error {
            div { class: "mb-4 border-2 border-danger/60 bg-danger/10 p-3 text-danger",
                if error == "basics" {
                    "{t(lang, \"add.errBasics\")}"
                } else if error == "coords" {
                    "{t(lang, \"add.errCoords\")}"
                }
            }
        }

        form {
            action: "{path_for_lang(\"/add\", lang)}",
            method: "post",
            class: "space-y-6 border-2 border-border bg-surface p-6",

            fieldset { class: "space-y-3",
                legend { class: "font-display text-sm tracking-wider uppercase text-fg-muted", "{t(lang, \"add.legendLocation\")}" }
                div { id: "pick-map", class: "h-72 w-full border-2 border-border-hi bg-bg sm:h-96" }
                p { class: "text-xs text-fg-dim", "{t(lang, \"add.mapHint\")}" }
                div { class: "grid grid-cols-2 gap-3",
                    label {
                        span { class: "block text-xs uppercase tracking-wider text-fg-dim", "{t(lang, \"add.lat\")}" }
                        input {
                            r#type: "number",
                            step: "any",
                            name: "lat",
                            required: true,
                            value: "{data.initial_lat}",
                            placeholder: "50.1109",
                            class: "mt-1 w-full font-mono {INPUT_CLS}",
                        }
                    }
                    label {
                        span { class: "block text-xs uppercase tracking-wider text-fg-dim", "{t(lang, \"add.lng\")}" }
                        input {
                            r#type: "number",
                            step: "any",
                            name: "lng",
                            required: true,
                            value: "{data.initial_lng}",
                            placeholder: "8.6821",
                            class: "mt-1 w-full font-mono {INPUT_CLS}",
                        }
                    }
                }
            }

            fieldset { class: "space-y-3",
                legend { class: "font-display text-sm tracking-wider uppercase text-fg-muted", "{t(lang, \"add.legendNameAddress\")}" }
                label {
                    span { class: "block text-xs uppercase tracking-wider text-fg-dim", "{t(lang, \"add.nameLabel\")}" }
                    input {
                        r#type: "text",
                        name: "name",
                        required: true,
                        maxlength: "200",
                        placeholder: "z. B. Kayo am Rebstock",
                        class: "mt-1 w-full {INPUT_CLS}",
                    }
                }
                input {
                    r#type: "text",
                    name: "street",
                    placeholder: "{t(lang, \"reportForm.street\")}",
                    class: "w-full {INPUT_CLS}",
                }
                div { class: "grid grid-cols-3 gap-3",
                    input {
                        r#type: "text",
                        name: "number",
                        placeholder: "{t(lang, \"reportForm.number\")}",
                        class: "{INPUT_CLS}",
                    }
                    input {
                        r#type: "text",
                        name: "postalcode",
                        placeholder: "{t(lang, \"reportForm.postalcode\")}",
                        maxlength: "5",
                        class: "{INPUT_CLS}",
                    }
                    input {
                        r#type: "text",
                        name: "city",
                        placeholder: "{t(lang, \"reportForm.city\")}",
                        class: "{INPUT_CLS}",
                    }
                }
                input {
                    r#type: "text",
                    name: "district",
                    placeholder: "{t(lang, \"add.district\")}",
                    class: "w-full {INPUT_CLS}",
                }
            }

            fieldset { class: "space-y-2",
                legend { class: "font-display text-sm tracking-wider uppercase text-fg-muted", "{t(lang, \"kiosk.descriptionHeading\")}" }
                textarea {
                    name: "description",
                    rows: "3",
                    maxlength: "2000",
                    placeholder: "{t(lang, \"add.descPlaceholder\")}",
                    class: "w-full {INPUT_CLS}",
                }
            }

            fieldset { class: "space-y-2",
                legend { class: "font-display text-sm tracking-wider uppercase text-fg-muted", "{t(lang, \"kiosk.openingHoursHeading\")}" }
                input {
                    r#type: "text",
                    name: "hours_raw",
                    placeholder: "Mo-Fr 09:00-22:00; Sa 10:00-20:00",
                    class: "w-full font-mono {INPUT_CLS}",
                }
                p { class: "text-xs text-fg-dim",
                    "{t(lang, \"reportForm.osmFormatPre\")}"
                    code { "opening_hours" }
                    "{t(lang, \"reportForm.osmFormatPost\")}"
                }
            }

            fieldset { class: "space-y-2",
                legend { class: "font-display text-sm tracking-wider uppercase text-fg-muted", "{t(lang, \"kiosk.paymentHeading\")}" }
                div { class: "grid grid-cols-2 gap-2 sm:grid-cols-3",
                    for key in PAYMENT_KEYS {
                        label { class: "flex items-center gap-2 border-2 border-border bg-surface-2 px-2 py-1.5 text-sm",
                            span { class: "flex-1 capitalize text-fg-muted", "{key}" }
                            select { name: "pay_{key}", class: "bg-transparent text-fg focus:outline-none",
                                option { value: "", "?" }
                                option { value: "yes", "{t(lang, \"radio.yes\")}" }
                                option { value: "no", "{t(lang, \"radio.no\")}" }
                                option { value: "unknown", "{t(lang, \"add.payUnknown\")}" }
                            }
                        }
                    }
                }
            }

            fieldset { class: "space-y-2",
                legend { class: "font-display text-sm tracking-wider uppercase text-fg-muted", "{t(lang, \"kiosk.tagsHeading\")}" }
                div { class: "flex flex-wrap gap-2",
                    for slug in TAGS {
                        label { class: "cursor-pointer border-2 border-border bg-surface-2 px-2 py-1 text-sm text-fg-muted has-[:checked]:border-neon-pink has-[:checked]:text-neon-pink",
                            input { r#type: "checkbox", name: "tags", value: "{slug}", class: "sr-only" }
                            "{tag_label(lang, slug)}"
                        }
                    }
                }
            }

            button { r#type: "submit", class: "btn-neon", "{t(lang, \"add.submit\")}" }
        }
    });

    let meta = PageMeta {
        title: Some(t(lang, "page.add.title")),
        noindex: true,
        entries: vec![ClientEntry::App, ClientEntry::Pick],
        nav: Some(Nav::Map),
        ..Default::default()
    };
    (body, meta)
}

#[cfg(test)]
mod tests {
    use trinkhallen_core::i18n::Lang;

    use super::*;

    #[test]
    fn form_fields_match_the_ts() {
        let (body, meta) = render(&AddData {
            lang: Lang::De,
            initial_lat: "50.11".into(),
            initial_lng: "8.68".into(),
            error: Some("basics".into()),
        });
        assert!(
            body.contains("<form action=\"/add\" method=\"post\""),
            "{body}"
        );
        assert!(
            body.contains("Name und Koordinaten sind Pflicht."),
            "{body}"
        );
        assert!(body.contains("<div id=\"pick-map\" class=\"h-72 w-full border-2 border-border-hi bg-bg sm:h-96\"></div>"), "{body}");
        for field in [
            "lat",
            "lng",
            "name",
            "street",
            "number",
            "postalcode",
            "city",
            "district",
            "description",
            "hours_raw",
        ] {
            assert!(
                body.contains(&format!("name=\"{field}\"")),
                "missing field {field}: {body}"
            );
        }
        assert!(body.contains("value=\"50.11\""), "{body}");
        assert!(body.contains("value=\"8.68\""), "{body}");
        // Payment tri-state selects and the tag checkboxes.
        for key in PAYMENT_KEYS {
            assert!(
                body.contains(&format!("name=\"pay_{key}\"")),
                "missing pay_{key}: {body}"
            );
        }
        assert!(
            body.contains("<option value=\"unknown\">Unbekannt</option>"),
            "{body}"
        );
        for slug in TAGS {
            assert!(
                body.contains(&format!("value=\"{slug}\"")),
                "missing tag {slug}: {body}"
            );
        }
        assert!(body.contains("▶ Vorschlag einreichen"), "{body}");
        assert!(meta.noindex);
        assert_eq!(meta.title.as_deref(), Some("Späti hinzufügen"));
    }

    #[test]
    fn form_action_follows_the_language() {
        let (body, _) = render(&AddData {
            lang: Lang::En,
            initial_lat: String::new(),
            initial_lng: String::new(),
            error: None,
        });
        assert!(
            body.contains("<form action=\"/en/add\" method=\"post\""),
            "{body}"
        );
    }
}
