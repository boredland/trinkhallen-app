//! Side-panel list — the `/api/kiosks/panel` fragment and
//! the map sidebar body.

use super::PanelData;

/// Markup for a panel fragment. Rows are pre-filtered and sorted by the
/// Worker; this renders at most those.
pub fn render(data: &PanelData) -> String {
    crate::components::kiosk_list::render(data)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use trinkhallen_core::i18n::Lang;
    use trinkhallen_core::kind::KioskKind;
    use trinkhallen_core::record::KioskRecord;

    use super::*;

    fn kiosk() -> KioskRecord {
        let mut address = BTreeMap::new();
        address.insert("street".into(), "Bornheimer Landstraße".into());
        address.insert("number".into(), "1".into());
        address.insert("district".into(), "Bornheim".into());
        address.insert("city".into(), "Frankfurt am Main".into());
        KioskRecord {
            id: "tk_fr_42".into(),
            region: "de/hessen/frankfurt".into(),
            name: "Testkiosk".into(),
            description: None,
            address,
            // No hours → the status label is time-independent, so the row
            // markup below is exactly what is rendered.
            hours: None,
            tags: vec!["wc".into()],
            payment: None,
            lng: 8.689,
            lat: 50.123,
            sources: None,
            updated_at: 0,
            updated: None,
            kind: KioskKind::Kiosk,
        }
    }

    fn data<'a>(kiosks: Vec<&'a KioskRecord>) -> PanelData<'a> {
        PanelData {
            lang: Lang::De,
            kiosks,
            total_in_bbox: 1,
            filtered_count: 1,
            open_now_count: None,
            filter_active: false,
            reset_href: None,
            origin: None,
            user_agent: None,
        }
    }

    #[test]
    fn row_matches_ts_markup() {
        let k = kiosk();
        let html = render(&data(vec![&k]));

        // Row skeleton + classes of the panel list.
        assert!(html.starts_with("<div class=\"block\">"), "{html}");
        assert!(
            html.contains("<ul class=\"divide-y-2 divide-border\"><li>"),
            "{html}"
        );
        assert!(html.contains(
            "<div class=\"flex items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-surface-2\">"
        ), "{html}");
        // Localized detail link, `data-lng`/`data-lat` map hooks.
        assert!(
            html.contains("<a href=\"/k/tk_fr_42\" data-lng=\"8.689\" data-lat=\"50.123\" class=\"flex-1 min-w-0\">"),
            "{html}"
        );
        assert!(
            html.contains(
                "<p class=\"truncate font-display text-base tracking-wide text-fg\">Testkiosk</p>"
            ),
            "{html}"
        );
        assert!(
            html.contains(
                "<p class=\"truncate text-sm text-fg-muted\">Bornheimer Landstraße 1 · Bornheim</p>"
            ),
            "{html}"
        );
        // Unknown status keeps its grey tone and ellipsis glyph.
        assert!(
            html.contains("<span class=\"text-fg-muted\">… Öffnungszeiten unbekannt</span>"),
            "{html}"
        );
        // The toilet chip comes from the tag vocabulary.
        assert!(
            html.contains("aria-label=\"WC\" title=\"WC\">🚻</span>"),
            "{html}"
        );
        // Navigate CTA, desktop UA → Google Maps web target (`&` is escaped in
        // attributes, exactly as the renderer writes it).
        assert!(html.contains(
            "<a href=\"https://www.google.com/maps/dir/?api=1&#38;destination=50.123,8.689&#38;destination_place_id=Testkiosk\" class=\"shrink-0 border-2 border-border-hi px-2 py-1 font-display text-xs tracking-wider uppercase text-fg-muted transition-colors hover:border-neon-pink hover:text-neon-pink\" aria-label=\"Hin navigieren zu Testkiosk\">▶ Nav</a>"),
            "{html}"
        );
    }

    #[test]
    fn english_row_uses_localized_href_and_copy() {
        let k = kiosk();
        let mut d = data(vec![&k]);
        d.lang = Lang::En;
        let html = render(&d);
        assert!(html.contains("href=\"/en/k/tk_fr_42\""), "{html}");
        assert!(html.contains("Opening hours unknown"), "{html}");
    }

    #[test]
    fn count_row_and_reset_link() {
        let k = kiosk();
        let mut d = data(vec![&k]);
        d.filtered_count = 3;
        d.total_in_bbox = 10;
        d.filter_active = true;
        d.reset_href = Some("/".into());
        d.open_now_count = Some(2);
        let html = render(&d);
        assert!(html.contains("3 / 10 (gefiltert)"), "{html}");
        assert!(
            html.contains("<span class=\"ml-2 text-status-open\">▶▶▶ 2 offen</span>"),
            "{html}"
        );
        assert!(html.contains("<a href=\"/\" class=\"text-fg-muted hover:text-neon-pink\" aria-label=\"Filter zurücksetzen\">× Reset</a>"), "{html}");
    }

    #[test]
    fn empty_state_offers_reset() {
        let mut d = data(vec![]);
        d.total_in_bbox = 5;
        d.filtered_count = 0;
        d.filter_active = true;
        d.reset_href = Some("/".into());
        let html = render(&d);
        assert!(html.contains("… nichts gefunden"), "{html}");
        assert!(html.contains("× Filter zurücksetzen"), "{html}");
    }
}
