//! Tags a visitor can add/remove through `update_tags` reports, grouped like
//! `schema/tags.json` in the data repo (keep the two in sync).

pub struct TagGroup {
    /// German key; localized via [`crate::i18n::tag_group_label`].
    pub label: &'static str,
    pub tags: &'static [&'static str],
}

pub const REPORTABLE_TAG_GROUPS: [TagGroup; 3] = [
    TagGroup { label: "Sortiment", tags: &["backwaren", "eis", "zeitungen", "gemischte_tuete", "gluecksspiele"] },
    TagGroup { label: "Ambiente", tags: &["innenraum", "stehtisch", "ueberdacht"] },
    TagGroup { label: "Ausstattung", tags: &["wc", "barrierefrei", "paketshop", "wlan", "geldautomat"] },
];

pub fn is_reportable_tag(slug: &str) -> bool {
    REPORTABLE_TAG_GROUPS.iter().any(|g| g.tags.contains(&slug))
}

pub fn reportable_tags() -> impl Iterator<Item = &'static str> {
    REPORTABLE_TAG_GROUPS.iter().flat_map(|g| g.tags.iter().copied())
}
