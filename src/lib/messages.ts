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

export type Lang = "de" | "en";
export const DEFAULT_LANG: Lang = "de";
export const SUPPORTED_LANGS: readonly Lang[] = ["de", "en"];
/** Languages other than the default get a URL path prefix (e.g. /en/...). */
export const PREFIXED_LANGS: readonly Exclude<Lang, typeof DEFAULT_LANG>[] = ["en"];

/** BCP-47 locale per language, for Intl date/number formatting. */
export const INTL_LOCALE: Record<Lang, string> = { de: "de-DE", en: "en-GB" };

/** Open Graph locale per language (`<meta property="og:locale">`). */
export const OG_LOCALE: Record<Lang, string> = { de: "de_DE", en: "en_GB" };

/**
 * Best-effort match of an Accept-Language header (or any candidate) to a
 * supported language. Used only for first-visit redirects; the authoritative
 * per-request language comes from the URL path (langFromPath).
 */
export function resolveLang(candidate?: string | null): Lang {
  const v = (candidate ?? "").slice(0, 2).toLowerCase();
  return (SUPPORTED_LANGS as readonly string[]).includes(v) ? (v as Lang) : DEFAULT_LANG;
}

/** The language a request URL path encodes (the /en prefix → "en", else "de"). */
export function langFromPath(path: string): Lang {
  for (const l of PREFIXED_LANGS) {
    if (path === `/${l}` || path.startsWith(`/${l}/`)) return l;
  }
  return DEFAULT_LANG;
}

/**
 * Rewrite a path to a target language: strips any existing lang prefix, then
 * adds the target's prefix (default lang has none). Used by the switcher and
 * hreflang alternates. Always returns a leading-slash path.
 */
export function pathForLang(path: string, target: Lang): string {
  let bare = path;
  for (const l of PREFIXED_LANGS) {
    if (bare === `/${l}`) bare = "/";
    else if (bare.startsWith(`/${l}/`)) bare = bare.slice(`/${l}`.length);
  }
  if (target === DEFAULT_LANG) return bare;
  return bare === "/" ? `/${target}` : `/${target}${bare}`;
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

  // page titles + meta descriptions
  "page.home.title": "Trinkhallen, Spätis & Wasserhäuschen finden",
  "page.home.description":
    "Karte mit Trinkhallen, Wasserhäuschen und Spätis in ganz Deutschland — gefiltert nach Öffnungszeiten, Zahlung und Tags. Ein Klick zur Navigation.",
  "page.jetzt.title": "Jetzt navigieren",
  "page.jetzt.description": "Direkt zum nächsten geöffneten Späti per Karten-App.",
  "page.cityNotFound.title": "Stadt nicht gefunden",
  "page.about.title": "Über trinkhallen.app",
  "page.about.description":
    "trinkhallen.app ist der offene Nachfolger von HopfenStop — Trinkhallen, Spätis und Wasserhäuschen in ganz Deutschland mit Öffnungszeiten, Kartenzahlung-Filter und Direktnavigation. Daten aus OpenStreetMap und der Community, offen auf GitHub.",
  "page.impressum.title": "Impressum",
  "page.impressum.description": "Impressum von trinkhallen.app — Angaben gemäß §5 TMG.",
  "page.datenschutz.title": "Datenschutz",
  "page.datenschutz.description":
    "Datenschutzerklärung von trinkhallen.app — welche Daten wir verarbeiten, warum, und wie du deine Rechte ausübst.",
  "page.notFound.title": "Nicht gefunden",
  "page.add.title": "Späti hinzufügen",
  "page.profile.title": "Profil",
  "page.kiosk.hours": "Öffnungszeiten",
  "page.kiosk.hoursHint": "Öffnungszeiten (Hinweise willkommen)",
  "page.kiosk.germany": "Deutschland",
  "city.breadcrumb": "Trinkhallen",
  "city.viewOnMap": "▶ Auf der Karte ansehen",
  "city.allOnMap": "Alle auf der Karte →",
  "notFound.heading": "404 — Kiosk nicht gefunden",
  "notFound.idMissingPre": "Die ID",
  "notFound.idMissingPost": "existiert nicht.",
  "notFound.backToMap": "Zurück zur Karte",
  "jetzt.intro":
    "Wir holen kurz deinen Standort, suchen den nächsten geöffneten Späti und öffnen deine Karten-App.",
  "jetzt.toMap": "Zur Karte",
  "jetzt.retry": "Erneut versuchen",
  "jetzt.noGeo":
    "Dein Browser unterstützt keine Standort-Anfrage. Öffne die Karte und such manuell.",
  "jetzt.locating": "Standort wird ermittelt …",
  "jetzt.searching": "Suche den nächsten geöffneten Späti …",
  "jetzt.noneOpen":
    "In deiner Nähe ist gerade nichts geöffnet. Schau auf die Karte für die volle Übersicht.",
  "jetzt.openingSuffix": " — Karten-App wird geöffnet …",
  "jetzt.lookupFailed": "Konnte den nächsten Späti nicht ermitteln. Öffne die Karte manuell.",
  "jetzt.geoFailed":
    "Wir konnten deinen Standort nicht lesen. Öffne die Karte und navigiere von dort.",

  // add a kiosk (/add)
  "add.heading": "Späti vorschlagen",
  "add.intro":
    "Dein Vorschlag wird von Moderator:innen geprüft und landet anschließend im offenen Datensatz.",
  "add.errBasics": "Name und Koordinaten sind Pflicht.",
  "add.errCoords": "Koordinaten sind ungültig.",
  "add.legendLocation": "Ort",
  "add.mapHint":
    "▶ Klick auf die Karte, um die genaue Position zu setzen. Geolokalisierung (Pfeil-Symbol oben rechts) füllt automatisch ein. Adresse wird aus der Kartenposition vorbefüllt — du kannst sie überschreiben.",
  "add.lat": "Breitengrad (lat)",
  "add.lng": "Längengrad (lng)",
  "add.legendNameAddress": "Name & Adresse",
  "add.nameLabel": "Name *",
  "add.district": "Stadtteil",
  "add.descPlaceholder": "Was macht den Späti besonders?",
  "add.payUnknown": "Unbekannt",
  "add.submit": "▶ Vorschlag einreichen",

  // profile (/me)
  "profile.role": "Rolle:",
  "profile.stat.checkins": "Check-ins",
  "profile.stat.signals": "Bestätigungen",
  "profile.stat.ratings": "Bewertungen",
  "profile.stat.corrections": "Korrekturen",
  "profile.stat.suggestions": "Vorschläge",
  "profile.linkAccounts":
    "Verknüpfe weitere Anmelde-Wege mit deinem Konto — du behältst dabei alle Bewertungen, Korrekturen und Check-ins.",
  "profile.connectApple": "Apple verbinden",
  "profile.connectGoogle": "Google verbinden",
  "profile.logout": "Abmelden",
  "profile.flash.submitted": "Vorschlag gespeichert. Moderator:innen schauen drüber.",
  "profile.flash.reported": "Hinweis gespeichert. Danke!",
  "profile.flash.linkOk": "Google-Konto verknüpft.",
  "profile.flash.linkConflict":
    "Dieses Google-Konto ist bereits mit einem anderen Profil hier verbunden. Melde dich dort an oder schreib uns, wenn wir die Konten zusammenführen sollen.",
  "profile.handle.heading": "Dein Handle",
  "profile.handle.changed": "Handle geändert.",
  "profile.handle.invalid": "Nur Kleinbuchstaben, Zahlen, Unterstrich. 3–24 Zeichen.",
  "profile.handle.reserved": "Dieser Handle ist reserviert. Wähl einen anderen.",
  "profile.handle.taken": "Schon vergeben. Wähl einen anderen.",
  "profile.handle.retired": "Dieser Handle war schon mal vergeben und ist gesperrt.",
  "profile.handle.unchanged": "Das ist bereits dein Handle.",
  "profile.handle.alreadyChanged":
    "Du hast deinen Handle bereits einmal geändert — er ist jetzt fest.",
  "profile.handle.renamePre": "Du kannst deinen Handle",
  "profile.handle.renameEmphasis": "einmal",
  "profile.handle.renamePost":
    "ändern — danach ist er fest. 3–24 Zeichen, Kleinbuchstaben, Zahlen, Unterstrich.",
  "profile.handle.newLabel": "Neuer Handle",
  "profile.handle.changeBtn": "Handle ändern",
  "profile.handle.fixed": "Dein Handle ist festgelegt und kann nicht mehr geändert werden.",
  "profile.suggestKiosk": "+ Späti vorschlagen",
  "profile.noSubmissionsPre": "Noch nichts vorgeschlagen — leg",
  "profile.noSubmissionsLink": "hier",
  "profile.noSubmissionsPost": "los.",
  "profile.noName": "(ohne Name)",
  "profile.prLink": "PR ansehen →",
  "profile.noCorrections": "Du hast noch keine Fehler gemeldet.",
  "profile.deleteHeading": "Konto löschen",
  "profile.deleteBodyPre":
    "Löscht dein Konto unwiderruflich: E-Mail, Username, Profil, Sitzungen, Bewertungen, Check-ins und offene Vorschläge oder Korrekturen werden entfernt. Korrekturen und Vorschläge, die bereits in den ",
  "profile.deleteBodyLink": "offenen Datensatz",
  "profile.deleteBodyPost":
    " übernommen wurden, bleiben dort bestehen — der Verweis auf dein Konto wird anonymisiert.",
  "profile.deleteUnconfirmed": "Bitte das Häkchen setzen, um die Löschung zu bestätigen.",
  "profile.deleteToggle": "Konto wirklich löschen…",
  "profile.deleteConfirmLabel":
    "Ich verstehe, dass diese Aktion endgültig ist und meine Daten nicht wiederhergestellt werden können.",
  "profile.deleteButton": "Konto unwiderruflich löschen",

  // moderation (admin)
  "mod.title": "Moderation",
  "mod.emptyHeading": "Saubere Inbox",
  "mod.noSubmissions": "Keine offenen Vorschläge.",
  "mod.noReports": "Keine offenen Korrekturen.",
  "mod.noUsers": "Keine Konten.",
  "mod.noAnomalies": "Keine offenen Anomalien.",
  "mod.reason": "Begründung (optional)",
  "mod.unban": "Entbannen",
  "mod.shadowban": "Shadow-bannen",
  "mod.by": "von",

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

// English overrides. Missing keys fall back to German per-key (see `t`), so this
// can be filled incrementally without breaking EN pages.
const EN: Record<string, string> = {};

export const MESSAGES: Record<Lang, Record<string, string>> = {
  de: DE,
  en: EN,
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
  "mod.tabSubmissions": "Vorschläge ({n})",
  "mod.tabReports": "Korrekturen ({n})",
  "mod.tabUsers": "Konten ({n})",
  "mod.tabAnomalies": "Anomalien ({n})",
  "page.kiosk.headline": "{name} — Späti in {city}",
  "page.kiosk.description":
    "{name} in {where} — {hours}, Zahlungsmethoden und ein Klick zur Navigation auf trinkhallen.app.",
  "page.city.title": "Trinkhallen, Spätis & Wasserhäuschen in {city}",
  "page.city.description":
    "{total} Trinkhallen, Spätis und Wasserhäuschen in {city} — mit Öffnungszeiten, Kartenzahlung und Direktnavigation. {openNow} jetzt offen.",
  "city.heading": "Spätis & Trinkhallen in {city}",
  "city.locations": "{total} Standorte in {city}.",
  "city.openNow": "{n} jetzt offen.",
  "city.showing": "{visible} von {total} angezeigt.",
} as const;

const EN_TPL: Record<string, string> = {};

export const TEMPLATES: Record<Lang, Record<string, string>> = {
  de: DE_TPL,
  en: EN_TPL,
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
  en: {},
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
  en: {},
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
  en: {},
};

/** Payment-method display labels (KioskDetail / CheckinForm); icons stay in-component. */
export const PAYMENT_LABELS: Record<Lang, Record<string, string>> = {
  de: {
    cash: "Bar",
    cards: "Karte",
    contactless: "Kontaktlos",
    girocard: "Girocard",
  },
  en: {},
};

/** Status pills on the profile page (distinct wording from REPORT_STATUS_LABELS). */
export const STATUS_PILL_LABELS: Record<Lang, Record<string, string>> = {
  de: {
    open: "Offen",
    pending: "Wartet",
    pr_opened: "Akzeptiert",
    approved: "Akzeptiert",
    merged: "Übernommen",
    dismissed: "Abgelehnt",
  },
  en: {},
};

/** Localized payment-method label; falls back to German then the slug. */
export function paymentLabel(lang: Lang, key: string): string {
  return PAYMENT_LABELS[lang][key] ?? PAYMENT_LABELS[DEFAULT_LANG][key] ?? key;
}

/** Reportable-tag group headings (lib/tags.ts). */
export const TAG_GROUP_LABELS: Record<Lang, Record<string, string>> = {
  de: {
    Sortiment: "Sortiment",
    Ambiente: "Ambiente",
    Ausstattung: "Ausstattung",
  },
  en: {},
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
  en: {
    unknown: "Opening hours unknown",
    open: "Open",
    closed: "Closed",
    closedLower: "closed",
    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  },
};
