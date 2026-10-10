//! `sitemap.xml`: one `<url>` per locale, each carrying the full reciprocal
//! hreflang set (Google requires it) plus `x-default` at the default locale.

use trinkhallen_core::ORIGIN;
use trinkhallen_core::i18n::{DEFAULT_LANG, SUPPORTED_LANGS, path_for_lang};

fn localized(bare: &str, extra: &str, out: &mut Vec<String>) {
    let mut alternates = String::new();
    for l in SUPPORTED_LANGS {
        alternates.push_str(&format!(
            "<xhtml:link rel=\"alternate\" hreflang=\"{}\" href=\"{ORIGIN}{}\"/>",
            l.code(),
            path_for_lang(bare, l)
        ));
    }
    alternates.push_str(&format!(
        "<xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"{ORIGIN}{}\"/>",
        path_for_lang(bare, DEFAULT_LANG)
    ));
    for l in SUPPORTED_LANGS {
        out.push(format!(
            "  <url><loc>{ORIGIN}{}</loc>{extra}{alternates}</url>",
            path_for_lang(bare, l)
        ));
    }
}

/// `today` is `YYYY-MM-DD`; `kiosks` are `(id, updated)` pairs for every
/// non-vending kiosk that has an id.
pub fn render(today: &str, region_slugs: &[&str], kiosks: &[(String, Option<String>)]) -> String {
    let mut lines = vec![
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>".to_owned(),
        "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\" xmlns:xhtml=\"http://www.w3.org/1999/xhtml\">"
            .to_owned(),
    ];
    localized(
        "/",
        &format!("<lastmod>{today}</lastmod><changefreq>daily</changefreq>"),
        &mut lines,
    );
    for page in ["/about", "/impressum", "/datenschutz"] {
        localized(page, &format!("<lastmod>{today}</lastmod>"), &mut lines);
    }
    for slug in region_slugs {
        localized(
            &format!("/stadt/{slug}"),
            &format!("<lastmod>{today}</lastmod><changefreq>daily</changefreq>"),
            &mut lines,
        );
    }
    for (id, updated) in kiosks {
        let extra = match updated.as_deref() {
            Some(u) if !u.is_empty() => format!("<lastmod>{u}</lastmod>"),
            _ => String::new(),
        };
        localized(&format!("/k/{id}"), &extra, &mut lines);
    }
    lines.push("</urlset>".to_owned());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_have_the_ts_importer_format() {
        let xml = render(
            "2026-08-23",
            &["frankfurt"],
            &[
                ("tk_fr_1".into(), Some("2026-05-01".into())),
                ("tk_fr_2".into(), None),
            ],
        );
        let lines: Vec<&str> = xml.lines().collect();
        assert_eq!(lines[0], "<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        assert_eq!(
            lines[1],
            "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\" xmlns:xhtml=\"http://www.w3.org/1999/xhtml\">"
        );
        assert_eq!(
            lines[2],
            "  <url><loc>https://trinkhallen.app/</loc><lastmod>2026-08-23</lastmod><changefreq>daily</changefreq>\
             <xhtml:link rel=\"alternate\" hreflang=\"de\" href=\"https://trinkhallen.app/\"/>\
             <xhtml:link rel=\"alternate\" hreflang=\"en\" href=\"https://trinkhallen.app/en\"/>\
             <xhtml:link rel=\"alternate\" hreflang=\"x-default\" href=\"https://trinkhallen.app/\"/></url>"
        );
        assert!(lines[3].starts_with("  <url><loc>https://trinkhallen.app/en</loc><lastmod>2026-08-23</lastmod><changefreq>daily</changefreq>"));
        assert!(lines[4].starts_with("  <url><loc>https://trinkhallen.app/about</loc><lastmod>2026-08-23</lastmod><xhtml:link"));
        // 2 home + 6 static + 2 city + 4 kiosk + 2 envelope + closing
        assert_eq!(lines.len(), 2 + 2 + 6 + 2 + 4 + 1);
        assert!(lines[10].contains("<loc>https://trinkhallen.app/stadt/frankfurt</loc>"));
        assert!(lines[12].starts_with("  <url><loc>https://trinkhallen.app/k/tk_fr_1</loc><lastmod>2026-05-01</lastmod><xhtml:link"));
        assert!(
            lines[14].starts_with("  <url><loc>https://trinkhallen.app/k/tk_fr_2</loc><xhtml:link")
        );
        assert!(lines[15].contains("<loc>https://trinkhallen.app/en/k/tk_fr_2</loc>"));
        assert_eq!(*lines.last().unwrap(), "</urlset>");
        assert!(!xml.ends_with('\n'));
    }
}
