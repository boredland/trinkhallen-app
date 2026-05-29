/**
 * Central message catalog — the single home for user-facing copy.
 *
 * Phase 1 of i18n: all strings live here keyed by language, accessed via
 * `t(lang, key)` for plain strings and `tpl(lang, key, vars)` for ones with
 * `{placeholders}`. Only German exists today; the structure is shaped so a
 * second language is "add a sibling block + a detector" rather than a re-touch
 * of every call site. `lang` is threaded explicitly through routes →
 * components → client islands (see resolveLang / the [data-lang] attribute).
 *
 * Deliberately NOT here (not UI chrome):
 *   - Domain/brand terms: Späti, Trinkhalle, Wasserhäuschen, Büdchen.
 *   - Bundesland names (lib/regions.ts) — required in German by the
 *     opening_hours holiday library.
 *   - The username generator wordlists (intentionally German-themed).
 *   - GitHub commit messages, test assertions, and `"de-DE"` Intl locale tags.
 */

export type Lang = "de";
export const DEFAULT_LANG: Lang = "de";
const SUPPORTED: readonly Lang[] = ["de"];

/** BCP-47 locale per language, for Intl date/number formatting. */
export const INTL_LOCALE: Record<Lang, string> = { de: "de-DE" };

/** Open Graph locale per language (`<meta property="og:locale">`). */
export const OG_LOCALE: Record<Lang, string> = { de: "de_DE" };

/**
 * Resolve the request/document language. Placeholder until detection lands
 * (Accept-Language / URL / cookie) — always German for now, but every caller
 * already routes through here so step 2 is a one-spot change.
 */
export function resolveLang(candidate?: string | null): Lang {
  const v = (candidate ?? "").slice(0, 2).toLowerCase();
  return (SUPPORTED as readonly string[]).includes(v) ? (v as Lang) : DEFAULT_LANG;
}

// ── Flat UI strings ──────────────────────────────────────────────────────────
// Dotted keys, grouped by surface. Plain strings only; interpolated copy lives
// in TEMPLATES below.

const DE = {
  // nav / chrome
  "nav.map": "Karte",
  "nav.about": "Über",
  "nav.mod": "Mod",
  "nav.themeToggle": "Theme wechseln",
  "meta.descriptionDefault":
    "Finde Trinkhallen, Wasserhäuschen und Spätis in deiner Nähe. Offen jetzt, Karte akzeptiert, ein Klick zur Navigation.",
  "meta.ogImageAlt": "trinkhallen.app — Karte deutscher Trinkhallen, Wasserhäuschen und Spätis",
  "footer.dataLicense": "Daten: CC BY-NC 4.0",
  "footer.aboutContribute": "Über & Mitwirken",
  "footer.imprint": "Impressum",
  "footer.privacy": "Datenschutz",

  // kiosk detail
  "kiosk.backToMap": "← Zurück zur Karte",
  "kiosk.navigate": "▶ Hin navigieren",
  "kiosk.openOtherMaps": "Anderes Maps-Programm öffnen",
  "kiosk.paymentHeading": "Zahlung",
  "kiosk.openingHoursHeading": "Öffnungszeiten",
  "kiosk.phBanner":
    "Heute ist Feiertag — diese Öffnungszeiten erwähnen keine Feiertagsregel. Die tatsächlichen Zeiten können abweichen. Ein verifizierter Check-in heute meldet uns automatisch, dass dieser Laden geöffnet hat.",
  "kiosk.descriptionHeading": "Beschreibung",
  "kiosk.tagsHeading": "Tags",
  "kiosk.wereYouHere": "Warst du hier?",
  "kiosk.ratingsHeading": "Bewertungen",
  "kiosk.dataWrong": "Daten falsch?",
  "kiosk.nearbyHeading": "In der Nähe",
  "kiosk.idLabel": "ID:",
  "kiosk.sourceLabel": "Quelle:",
  "kiosk.updatedLabel": "Aktualisiert:",
  "kiosk.editOnGithub": "Auf GitHub bearbeiten →",

  // check-in + gap-fill
  "checkin.iWasHere": "Ich war hier",
  "checkin.thanksWhatMissing": "Danke! Was hat gefehlt?",
  "checkin.whatMissingHint": "Was hat gefehlt? Jede Antwort hilft. Du kannst auch nichts angeben.",
  "checkin.hoursOk": "Stimmen die Öffnungszeiten?",
  "checkin.paymentOk": "Stimmen die Zahlungsoptionen?",
  "checkin.tagsOk": "Stimmen die hinterlegten Tags?",
  "checkin.confirm": "Passt — bestätigen",
  "checkin.dispute": "Stimmt nicht",
  "checkin.loginToContribute": "um deinen Besuch festzuhalten und Daten zu ergänzen.",
  "checkin.send": "Senden",
  "checkin.thanks": "Danke!",
  "checkin.hoursQ": "Öffnungszeiten?",
  "checkin.paymentQ": "Zahlung möglich?",
  "checkin.amenitiesQ": "Was gibt's hier?",
  "checkin.nameToggle": "Heißt eigentlich anders?",
  "checkin.nameLabel": "Richtiger Name",

  // tri-state radio options
  "radio.yes": "Ja",
  "radio.no": "Nein",
  "radio.unknown": "Weiß nicht",

  // settled-payment inline display (lowercase)
  "payment.yesLower": "ja",
  "payment.noLower": "nein",

  // report form
  "reportForm.loginHint": "und uns auf einen Fehler in den Daten hinweisen.",
  "reportForm.allReported": "Du hast bereits zu allen Kategorien etwas gemeldet — danke!",
  "reportForm.toggle": "Falsche oder fehlende Info melden",
  "reportForm.whatsWrong": "Was stimmt nicht?",
  "reportForm.correctTimes": "Richtige Zeiten",
  "reportForm.osmFormatPre": "OSM ",
  "reportForm.osmFormatPost": "-Format.",
  "reportForm.correctAddress": "Korrekte Adresse",
  "reportForm.street": "Straße",
  "reportForm.number": "Nr",
  "reportForm.postalcode": "PLZ",
  "reportForm.city": "Stadt",
  "reportForm.noteOptional": "Notiz (optional)",
  "reportForm.notePlaceholder": "Was sollte sich ändern?",
  "reportForm.submit": "▶ Melden",
  "reportForm.moderated": "Wird von Moderator:innen geprüft.",
  "reportForm.alreadyReported": "Du hast hier bereits gemeldet:",
  "reportForm.kindWrongHours": "Falsche Öffnungszeiten",
  "reportForm.kindWrongAddress": "Falsche Adresse",
  "reportForm.kindClosed": "Dauerhaft geschlossen",
  "reportForm.kindDuplicate": "Doppelter Eintrag",
  "reportForm.kindOther": "Sonstiges",

  // filter chips
  "filter.openNow": "Offen jetzt",
  "filter.needsHours": "Zeiten fehlen",
  "filter.sitzen": "Sitzen",
  "filter.searchPlaceholder": "Suchen…",
  "filter.apply": "Filter anwenden",

  // kiosk list
  "kioskList.nothingFound": "… nichts gefunden",
  "kioskList.nothingHint":
    "Keine Trinkhallen in diesem Bereich – zoom raus oder lockere die Filter.",
  "kioskList.resetLong": "× Filter zurücksetzen",
  "kioskList.resetShort": "× Reset",
  "kioskList.resetAria": "Filter zurücksetzen",
  "kioskList.distanceAria": "Entfernung",
  "kioskList.nav": "▶ Nav",

  // auth
  "auth.login": "Anmelden",

  // generic / errors
  "error.loginRequired": "Bitte anmelden.",
  "error.kioskNotFound": "Kiosk nicht gefunden",
  "error.badRequest": "Bad request",
  "error.badAction": "Bad action",
  "error.alreadyReportedKind": "Du hast diese Kategorie für diesen Späti bereits gemeldet.",
  "reports.thanksReviewing": "Danke! Wir prüfen das.",
  "rating.anonymous": "Anonym",
  "rating.noneYet": "Noch keine Bewertungen — sei die erste Person.",
  "rating.yours": "Deine Bewertung",
  "rating.rate": "Bewerten",
  "rating.commentSr": "Kommentar",
  "rating.commentPlaceholder": "Optionaler Kommentar (max. 500 Zeichen)",
  "rating.update": "Aktualisieren",
  "rating.submit": "Abgeben",
  "rating.delete": "Löschen",
  "rating.starsAria": "Sterne",
  "rating.loginToRateTail": ", um diesen Späti zu bewerten.",

  // client islands (rendered in the browser; lang read from <html lang>)
  "client.confirmed": "Bestätigt",
  "client.noted": "Notiert",
  "client.errInternal": "Interner Fehler — kann nicht senden.",
  "client.errNetwork": "Netzwerkfehler — bitte erneut versuchen.",
  "client.alreadyReported": "Bereits gemeldet.",
  "client.rating.pickStars": "Bitte wähle 1–5 Sterne aus.",
  "client.rating.loginToRate": "Bitte melde dich an, um zu bewerten.",
  "client.rating.saveFailed":
    "Konnte die Bewertung nicht speichern. Bitte später erneut versuchen.",
  "client.install.description":
    "Trinkhallen, Spätis und Wasserhäuschen — auf der Karte oder als Liste.",
  "client.install.installDescription":
    "Zum Home-Bildschirm hinzufügen für Vollbild ohne URL-Leiste.",
  "client.sw.newVersion": "Neue Version verfügbar.",
  "client.sw.reload": "Neu laden",
  "client.sw.loading": "Lädt …",
  "client.sw.close": "Schließen",
} as const;

export const MESSAGES: Record<Lang, Record<string, string>> = {
  de: DE,
};

export type MessageKey = keyof typeof DE;

export function t(lang: Lang, key: MessageKey): string {
  return MESSAGES[lang][key] ?? MESSAGES[DEFAULT_LANG][key] ?? key;
}

// ── Interpolated templates ───────────────────────────────────────────────────

const DE_TPL = {
  "oh.openUntil": "Offen bis {time}",
  "oh.closedOpensAt": "Geschlossen — öffnet {time}",
  "kiosk.introCityDistrict": "{name} ist ein Späti im Stadtteil {district} in {city}.",
  "kiosk.introCity": "{name} ist ein Späti in {city}.",
  "kioskList.countAll": "{n} Trinkhalle{suffix}",
  "kioskList.countFiltered": "{filtered} / {total} (gefiltert)",
  "kioskList.openNow": "{n} offen",
  "kioskList.navTo": "Hin navigieren zu {name}",
  "client.signalOk": "✓ {verb} — danke!",
  "client.signalLow": "{verb}, ohne Vor-Ort-Prüfung — zählt nur leise.",
  "client.errServer": "Server-Fehler ({status}). Bitte erneut versuchen.",
  "rating.count": "{n} Bewertung{suffix}",
  "rating.starsOfFive": "{n} von 5 Sternen",
  "rating.nStars": "{n} Sterne",
} as const;

export const TEMPLATES: Record<Lang, Record<string, string>> = {
  de: DE_TPL,
};

export type TemplateKey = keyof typeof DE_TPL;

export function tpl(lang: Lang, key: TemplateKey, vars: Record<string, unknown>): string {
  const template = TEMPLATES[lang][key] ?? TEMPLATES[DEFAULT_LANG][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}

// ── Domain label maps (dynamic slug → label, per language) ───────────────────

/** Report kinds (lib/reports.ts). */
export const REPORT_KIND_LABELS: Record<Lang, Record<string, string>> = {
  de: {
    wrong_hours: "Öffnungszeiten",
    wrong_address: "Adresse",
    wrong_name: "Name",
    closed: "Geschlossen",
    duplicate: "Duplikat",
    update_payment: "Zahlungsarten",
    update_tags: "Ausstattung",
    ph_open_observed: "Feiertags-Öffnung beobachtet",
    other: "Sonstiges",
  },
};

/** Report status labels — note pr_opened/approved deliberately collapse to one. */
export const REPORT_STATUS_LABELS: Record<Lang, Record<string, string>> = {
  de: {
    open: "In Prüfung",
    pending: "In Prüfung",
    pr_opened: "Akzeptiert",
    approved: "Akzeptiert",
    merged: "Übernommen",
    dismissed: "Abgelehnt",
  },
};

/** Tag display overrides (lib/tags.ts); slugs not listed fall back to titlecase. */
export const TAG_LABELS: Record<Lang, Record<string, string>> = {
  de: {
    applewoi: "Äppler",
    fritz_kola: "fritz-kola",
    gemischte_tuete: "Gemischte Tüte",
    gluecksspiele: "Glücksspiele",
    ueberdacht: "Überdacht",
    draussen: "Draußen",
    gemuetlich: "Gemütlich",
    wohnzimmer: "Wie ein Wohnzimmer",
    craft_bier: "Craft-Bier",
    raucherbereich: "Raucherbereich",
    barrierefrei: "Barrierefrei",
    sonne: "Sonnig",
    wc: "WC",
    sitzgelegenheiten: "Sitzgelegenheiten",
    wlan: "WLAN",
    geldautomat: "Geldautomat",
  },
};

/** Payment-method display labels (KioskDetail / CheckinForm); icons stay in-component. */
export const PAYMENT_LABELS: Record<Lang, Record<string, string>> = {
  de: {
    cash: "Bar",
    cards: "Karte",
    contactless: "Kontaktlos",
    girocard: "Girocard",
  },
};

/** Localized payment-method label; unknown keys fall back to the slug. */
export function paymentLabel(lang: Lang, key: string): string {
  return PAYMENT_LABELS[lang][key] ?? key;
}

/** Reportable-tag group headings (lib/tags.ts). */
export const TAG_GROUP_LABELS: Record<Lang, Record<string, string>> = {
  de: {
    Sortiment: "Sortiment",
    Ambiente: "Ambiente",
    Ausstattung: "Ausstattung",
  },
};

/** Opening-hours status words + weekday abbreviations (lib/opening-hours.ts). */
export const OH_LABELS: Record<
  Lang,
  { unknown: string; open: string; closed: string; closedLower: string; days: readonly string[] }
> = {
  de: {
    unknown: "Öffnungszeiten unbekannt",
    open: "Offen",
    closed: "Geschlossen",
    closedLower: "geschlossen",
    days: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
  },
};
