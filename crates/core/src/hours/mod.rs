//! Opening-hours evaluation.
//!
//! Most of the dataset's rules (~88 %) are plain weekly recurrences; the
//! importer bakes those into a flat array of minute offsets and the hot paths
//! (map panel, city pages, open-now filter) answer with a binary search
//! instead of a parse. Rules the flattening cannot reproduce — holidays,
//! solar times, month ranges, open ends — go through the `opening-hours`
//! evaluator with the kiosk's Bundesland public-holiday calendar.
//!
//! Wall-clock semantics: OSM times are local, and the original Worker ran in
//! UTC with `opening_hours.js` reading them as local — so "now" is the UTC
//! wall clock. That quirk is preserved deliberately: changing it would shift
//! every open/closed answer by one or two hours relative to the live site.

mod holidays_de;

use std::sync::{Arc, OnceLock};

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use opening_hours::{Context, ContextHolidays, OpeningHours};

use crate::i18n::{Lang, oh_labels, tpl};
use crate::record::{Hours, KioskRecord};
use crate::regions::bundesland_for_region;

pub const WEEK_MINUTES: u32 = 7 * 24 * 60;

/// Rules whose evaluation depends on the calendar date, or whose flattening
/// disagrees with the evaluator. Mirrors the importer's original regex:
/// `sunrise|sunset|dawn|dusk|\[[-0-9]+\]|\b20\d\d\b|(^|[\s,;])(PH|SH)(\b|,)|
/// \b(Jan|…|Dec)\b|\+|"|unknown` (case-insensitive).
pub fn is_flattenable(raw: &str) -> bool {
    let lower = raw.to_lowercase();
    for w in ["sunrise", "sunset", "dawn", "dusk", "unknown"] {
        if lower.contains(w) {
            return false;
        }
    }
    if raw.contains('+') || raw.contains('"') {
        return false;
    }
    let bytes = raw.as_bytes();
    // \[[-0-9]+\]
    let mut i = 0;
    while let Some(off) = raw[i..].find('[') {
        let start = i + off + 1;
        let mut j = start;
        while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'-') {
            j += 1;
        }
        if j > start && j < bytes.len() && bytes[j] == b']' {
            return false;
        }
        i = start;
    }
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let tokens = word_tokens(raw);
    for (start, tok) in &tokens {
        let t = tok.to_lowercase();
        // \b20\d\d\b
        if tok.len() == 4 && tok.starts_with("20") && tok[2..].bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        if ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].contains(&t.as_str())
        {
            return false;
        }
        // (^|[\s,;])(PH|SH)(\b|,) — case-insensitive, preceded by start/space/comma/semicolon.
        if t == "ph" || t == "sh" {
            let ok_before = *start == 0 || matches!(bytes[start - 1], b' ' | b'\t' | b'\n' | b',' | b';');
            let end = start + tok.len();
            let ok_after = end == bytes.len() || !is_word(bytes[end]) || bytes[end] == b',';
            if ok_before && ok_after {
                return false;
            }
        }
    }
    true
}

fn word_tokens(s: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in s.char_indices() {
        let w = c.is_ascii_alphanumeric() || c == '_';
        match (w, start) {
            (true, None) => start = Some(i),
            (false, Some(st)) => {
                out.push((st, &s[st..i]));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(st) = start {
        out.push((st, &s[st..]));
    }
    out
}

/// Minute of the week for a UTC instant, Monday 00:00 = 0.
pub fn week_minute(now: DateTime<Utc>) -> u32 {
    now.weekday().num_days_from_monday() * 1440 + now.hour() * 60 + now.minute()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WeekState {
    pub open: bool,
    /// Minutes until the next transition; `None` when the schedule never changes.
    pub until: Option<u32>,
}

/// Binary search over the baked schedule (alternating open/close boundaries,
/// strictly ascending; an odd insertion index means "inside an open span").
/// A span crossing Sunday midnight is stored truncated at `WEEK_MINUTES` and
/// re-entering at 0.
pub fn state_from_week(week: &[u32], minute: u32) -> WeekState {
    if week.is_empty() {
        return WeekState { open: false, until: None };
    }
    let wraps = week[0] == 0 && *week.last().unwrap_or(&0) == WEEK_MINUTES;
    if wraps && week.len() == 2 {
        return WeekState { open: true, until: None };
    }
    let lo = week.partition_point(|&b| b <= minute);
    let next = if lo < week.len() { week[lo] } else { week[0] + WEEK_MINUTES };
    // Landing on the wrap seam is not a transition — the span continues.
    let boundary = if wraps && next % WEEK_MINUTES == 0 { week[1] + WEEK_MINUTES } else { next };
    let wm = WEEK_MINUTES as i64;
    let until = (((boundary as i64 - minute as i64) % wm) + wm) % wm;
    WeekState { open: lo & 1 == 1, until: Some(until as u32) }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Unknown,
    Open { until: Option<DateTime<Utc>> },
    Closed { until: Option<DateTime<Utc>> },
}

impl Status {
    pub fn is_open(self) -> bool {
        matches!(self, Status::Open { .. })
    }
}

/// Holiday calendar for a Bundesland (full German name), built once.
fn holidays_for(state: &str) -> Option<ContextHolidays> {
    static CACHE: OnceLock<Vec<(&'static str, ContextHolidays)>> = OnceLock::new();
    let all = CACHE.get_or_init(|| {
        holidays_de::HOLIDAYS_DE
            .iter()
            .map(|(name, days)| {
                let cal: compact_calendar::CompactCalendar = days
                    .iter()
                    .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                    .collect();
                (*name, ContextHolidays::new(Arc::new(cal), Arc::default()))
            })
            .collect()
    });
    all.iter().find(|(n, _)| *n == state).map(|(_, h)| h.clone())
}

/// Bundesland for a kiosk, when its region is German.
pub fn kiosk_state(kiosk: &KioskRecord) -> Option<&'static str> {
    bundesland_for_region(&kiosk.region)
}

fn naive_utc(now: DateTime<Utc>) -> NaiveDateTime {
    now.naive_utc()
}

fn evaluator(raw: &str, state: Option<&str>) -> Option<OpeningHours> {
    let oh = raw.parse::<OpeningHours>().ok()?;
    Some(match state.and_then(holidays_for) {
        Some(h) => oh.with_context(Context::default().with_holidays(h)),
        None => oh,
    })
}

/// Current open/closed status. Fast path whenever `hours.week` is present.
pub fn compute_status(hours: Option<&Hours>, now: DateTime<Utc>, state: Option<&str>) -> Status {
    let Some(hours) = hours.filter(|h| !h.raw.is_empty()) else {
        return Status::Unknown;
    };
    if let Some(week) = &hours.week {
        let s = state_from_week(week, week_minute(now));
        let at = s.until.map(|m| now + Duration::minutes(m as i64));
        return if s.open { Status::Open { until: at } } else { Status::Closed { until: at } };
    }
    let Some(oh) = evaluator(&hours.raw, state) else {
        return Status::Unknown;
    };
    let t = naive_utc(now);
    let open = oh.is_open(t);
    let next = oh
        .next_change(t)
        .map(|n| Utc.from_utc_datetime(&n))
        // The evaluator reports a far-future sentinel for "never changes".
        .filter(|n| n.year() < 9000);
    if open { Status::Open { until: next } } else { Status::Closed { until: next } }
}

pub fn compute_kiosk_status(kiosk: &KioskRecord, now: DateTime<Utc>) -> Status {
    compute_status(kiosk.hours.as_ref(), now, kiosk_state(kiosk))
}

/// "Offen bis 22:00" / "Geschlossen — öffnet 08:00" / plain labels. Times are
/// rendered as UTC wall clock (see module docs).
pub fn format_status(lang: Lang, s: Status) -> String {
    let l = oh_labels(lang);
    let fmt = |d: DateTime<Utc>| format!("{:02}:{:02}", d.hour(), d.minute());
    match s {
        Status::Unknown => l.unknown.to_owned(),
        Status::Open { until: Some(t) } => tpl(lang, "oh.openUntil", &[("time", &fmt(t))]),
        Status::Open { until: None } => l.open.to_owned(),
        Status::Closed { until: Some(t) } => tpl(lang, "oh.closedOpensAt", &[("time", &fmt(t))]),
        Status::Closed { until: None } => l.closed.to_owned(),
    }
}

/// Is `now` a public holiday in the given Bundesland? `false` without a state.
pub fn is_public_holiday(state: Option<&str>, now: DateTime<Utc>) -> bool {
    state.and_then(holidays_for).is_some_and(|h| h.get_public().contains(now.date_naive()))
}

/// True when the raw rule mentions `PH` as a token (`PH off`, `PH 10:00-14:00`,
/// `PH,Su …`) — `(^|[\s,;])PH(\b|,)`, case-sensitive.
pub fn has_ph_token(raw: Option<&str>) -> bool {
    let Some(raw) = raw else { return false };
    let b = raw.as_bytes();
    let mut i = 0;
    while let Some(off) = raw[i..].find("PH") {
        let s = i + off;
        let before_ok = s == 0 || matches!(b[s - 1], b' ' | b'\t' | b'\n' | b',' | b';');
        let e = s + 2;
        let after_ok = e == b.len() || !(b[e].is_ascii_alphanumeric() || b[e] == b'_');
        if before_ok && after_ok {
            return true;
        }
        i = s + 1;
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoursRow {
    pub days: String,
    pub hours: String,
}

/// Reference week (Mon 2024-01-15 … Mon 2024-01-22) for the canonical table.
fn week_start() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2024, 1, 15).and_then(|d| d.and_hms_opt(0, 0, 0)).unwrap_or_default()
}

/// Flatten a rule into alternating minute offsets over the reference week, or
/// `None` when it must stay on the evaluator (see [`is_flattenable`]).
pub fn flatten_week(raw: &str) -> Option<Vec<u32>> {
    if !is_flattenable(raw) {
        return None;
    }
    let oh = raw.parse::<OpeningHours>().ok()?;
    let start = week_start();
    let end = start + Duration::days(7);
    let mut week = Vec::new();
    for r in oh.iter_range(start, end) {
        if r.kind != opening_hours::RuleKind::Open {
            continue;
        }
        let a = (r.range.start.max(start) - start).num_minutes();
        let b = (r.range.end.min(end) - start).num_minutes();
        if a == b {
            continue;
        }
        // Merge touching spans so boundaries stay strictly ascending.
        if let Some(last) = week.last_mut() {
            if *last as i64 == a {
                *last = b as u32;
                continue;
            }
        }
        week.push(a as u32);
        week.push(b as u32);
    }
    for w in week.windows(2) {
        if w[1] <= w[0] {
            return None;
        }
    }
    if week.iter().any(|&m| m > WEEK_MINUTES) {
        return None;
    }
    Some(week)
}

/// Human-readable weekly table: rows of day labels + time ranges, consecutive
/// identical days grouped. `None` when the rule cannot be parsed.
pub fn format_hours_table(lang: Lang, raw: Option<&str>, state: Option<&str>) -> Option<Vec<HoursRow>> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let l = oh_labels(lang);
    let oh = evaluator(raw, state)?;
    let start = week_start();
    let end = start + Duration::days(7);
    let mut day_slots: Vec<Vec<(String, String)>> = vec![Vec::new(); 7];
    let fmt = |t: NaiveDateTime| format!("{:02}:{:02}", t.hour(), t.minute());
    for r in oh.iter_range(start, end) {
        if r.kind != opening_hours::RuleKind::Open {
            continue;
        }
        let mut cur = r.range.start.max(start);
        let stop = r.range.end.min(end);
        while cur < stop {
            let day = (cur - start).num_days();
            if !(0..7).contains(&day) {
                break;
            }
            let day_start = start + Duration::days(day);
            let day_end = day_start + Duration::days(1);
            let slot_end = stop.min(day_end);
            let end_str = if slot_end == day_end { "24:00".to_owned() } else { fmt(slot_end) };
            day_slots[day as usize].push((fmt(cur.max(day_start)), end_str));
            cur = day_end;
        }
    }
    // Fold cross-midnight spillover ("08:00–24:00" + next day "00:00–00:30")
    // into one "08:00–00:30" slot; full days and 24/7 are left alone.
    for d in 0..7 {
        let next_i = (d + 1) % 7;
        let fold = match (day_slots[d].last(), day_slots[next_i].first()) {
            (Some(last), Some(head)) => {
                last.1 == "24:00" && last.0 != "00:00" && head.0 == "00:00" && head.1 != "24:00"
            }
            _ => false,
        };
        if fold {
            let head_end = day_slots[next_i].remove(0).1;
            if let Some(last) = day_slots[d].last_mut() {
                last.1 = head_end;
            }
        }
    }
    let fmt_slots = |slots: &[(String, String)]| {
        slots.iter().map(|(s, e)| format!("{s}–{e}")).collect::<Vec<_>>().join(", ")
    };
    let mut rows = Vec::new();
    let mut i = 0;
    while i < 7 {
        let hours = fmt_slots(&day_slots[i]);
        let mut j = i + 1;
        while j < 7 && fmt_slots(&day_slots[j]) == hours {
            j += 1;
        }
        let count = j - i;
        let days = if count >= 3 {
            format!("{}–{}", l.days[i], l.days[j - 1])
        } else if count == 2 {
            format!("{}, {}", l.days[i], l.days[j - 1])
        } else {
            l.days[i].to_owned()
        };
        rows.push(HoursRow { days, hours: if hours.is_empty() { l.closed_lower.to_owned() } else { hours } });
        i = j;
    }
    Some(rows)
}

/// Kiosks open at `now`; flattened rules skip both the parse and the region lookup.
pub fn count_open_now(records: &[&KioskRecord], now: DateTime<Utc>) -> usize {
    let minute = week_minute(now);
    records
        .iter()
        .filter(|r| match &r.hours {
            Some(h) if !h.raw.is_empty() => match &h.week {
                Some(week) => state_from_week(week, minute).open,
                None => compute_status(Some(h), now, kiosk_state(r)).is_open(),
            },
            _ => false,
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, min, 0).unwrap()
    }

    #[test]
    fn week_minute_monday_zero() {
        assert_eq!(week_minute(utc(2026, 8, 17, 0, 0)), 0);
        assert_eq!(week_minute(utc(2026, 8, 23, 23, 59)), WEEK_MINUTES - 1);
    }

    #[test]
    fn state_from_week_cases() {
        assert_eq!(state_from_week(&[], 500), WeekState { open: false, until: None });
        assert_eq!(state_from_week(&flatten_week("24/7").unwrap(), 5000), WeekState { open: true, until: None });
        let mo = flatten_week("Mo 09:00-17:00").unwrap();
        assert_eq!(mo, vec![540, 1020]);
        assert_eq!(state_from_week(&mo, 480), WeekState { open: false, until: Some(60) });
        assert_eq!(state_from_week(&mo, 600), WeekState { open: true, until: Some(420) });
        assert!(state_from_week(&mo, 540).open);
        assert!(!state_from_week(&mo, 1020).open);
        assert_eq!(state_from_week(&mo, 6 * 1440 + 23 * 60), WeekState { open: false, until: Some(600) });
        let late = flatten_week("Mo-Su 09:00-01:00").unwrap();
        let s = state_from_week(&late, 6 * 1440 + 23 * 60 + 30);
        assert!(s.open);
        assert_eq!(s.until, Some(90));
    }

    #[test]
    fn flattenable() {
        for ok in ["Mo-Sa 06:00-22:00", "24/7"] {
            assert!(is_flattenable(ok), "{ok}");
        }
        for no in [
            "Mo-Sa 06:00-22:00; PH off",
            "Mo-Fr 08:00-sunset",
            "Mar-Oct 10:00-20:00",
            "Sa[1] 10:00-14:00",
            "2026 Mo-Fr 09:00-17:00",
            "SH Mo-Fr 09:00-17:00",
            "Fr 17:00+",
            "Mo-Fr 09:00-17:00; Sa unknown",
            "\"nach Bedarf\"",
        ] {
            assert!(!is_flattenable(no), "{no}");
        }
    }

    #[test]
    fn fast_path_agrees_with_evaluator() {
        for raw in [
            "Mo-Sa 06:00-22:00",
            "24/7",
            "Mo-Fr 09:00-17:00; Sa 10:00-14:00",
            "Mo-Su 09:00-01:00",
            "Tu-Su 11:00-23:00",
            "Mo-Fr 06:00-09:00,15:00-19:00",
        ] {
            let week = flatten_week(raw).unwrap();
            let fast = Hours { raw: raw.into(), week: Some(week) };
            let slow = Hours { raw: raw.into(), week: None };
            for day in 0..7 {
                for hour in [0, 1, 6, 9, 12, 17, 22, 23] {
                    let now = utc(2026, 8, 17 + day, hour, 31);
                    let f = compute_status(Some(&fast), now, None);
                    let s = compute_status(Some(&slow), now, None);
                    assert_eq!(f.is_open(), s.is_open(), "{raw} @ {now}");
                    if let (Status::Open { until: Some(a) } | Status::Closed { until: Some(a) },
                            Status::Open { until: Some(b) } | Status::Closed { until: Some(b) }) = (f, s) {
                        assert_eq!(a, b, "{raw} @ {now}");
                    }
                }
            }
        }
    }

    #[test]
    fn holidays_per_bundesland() {
        let ph = utc(2026, 10, 3, 12, 0); // Tag der Deutschen Einheit (Saturday)
        let plain = utc(2026, 9, 26, 12, 0);
        let rule = Hours { raw: "Mo-Sa 06:00-22:00; PH off".into(), week: None };
        assert!(!compute_status(Some(&rule), ph, Some("Hessen")).is_open());
        assert!(compute_status(Some(&rule), plain, Some("Hessen")).is_open());
        assert!(is_public_holiday(Some("Hessen"), ph));
        assert!(!is_public_holiday(Some("Hessen"), plain));
        assert!(!is_public_holiday(None, ph));
        let fronleichnam = utc(2026, 6, 4, 12, 0);
        assert!(is_public_holiday(Some("Bayern"), fronleichnam));
        assert!(!is_public_holiday(Some("Berlin"), fronleichnam));
    }

    #[test]
    fn ph_token() {
        assert!(has_ph_token(Some("Mo-Sa 06:00-22:00; PH off")));
        assert!(has_ph_token(Some("Mo-Sa 06:00-22:00; PH 10:00-14:00")));
        assert!(has_ph_token(Some("PH,Su 12:00-20:00")));
        assert!(!has_ph_token(Some("PHARMACY hours: Mo-Fr 08:00-18:00")));
        assert!(!has_ph_token(Some("Mo-Sa 06:00-22:00")));
        assert!(!has_ph_token(Some("")));
        assert!(!has_ph_token(None));
    }

    #[test]
    fn table() {
        let rows = format_hours_table(Lang::De, Some("Mo-Fr 09:00-22:00; Sa 10:00-20:00"), None).unwrap();
        assert_eq!(
            rows,
            vec![
                HoursRow { days: "Mo–Fr".into(), hours: "09:00–22:00".into() },
                HoursRow { days: "Sa".into(), hours: "10:00–20:00".into() },
                HoursRow { days: "So".into(), hours: "geschlossen".into() },
            ]
        );
        let late = format_hours_table(Lang::De, Some("Mo-Su 08:00-00:30"), None).unwrap();
        assert_eq!(late, vec![HoursRow { days: "Mo–So".into(), hours: "08:00–00:30".into() }]);
    }

    #[test]
    fn status_labels() {
        let now = utc(2026, 8, 17, 10, 0);
        let h = Hours { raw: "Mo 09:00-17:00".into(), week: Some(vec![540, 1020]) };
        assert_eq!(format_status(Lang::De, compute_status(Some(&h), now, None)), "Offen bis 17:00");
        assert_eq!(format_status(Lang::En, Status::Unknown), "Opening hours unknown");
    }
}
