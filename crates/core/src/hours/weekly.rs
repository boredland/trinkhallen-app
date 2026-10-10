//! opening_hours.js-compatible evaluation for the rule subset nearly every
//! kiosk uses: weekday lists/ranges, `PH`, fixed time spans (overnight and
//! extended times included), open ends (`18:00+`), `off`/`closed`/`open`,
//! comments, `24/7`, `,`-joined additional rules and a `||` fallback.
//!
//! Why not the `opening-hours` crate for these: it drops a span's spill past
//! midnight whenever a later rule matches the next day, so
//! `Mo-Fr 06:30-01:00; Sa-Su 07:30-01:00` reads as closed Monday 00:30; it
//! treats commented rules as open where opening_hours.js reports "unknown";
//! and it rejects the `Mo - Fr` / `Tu, We` spellings opening_hours.js
//! accepts. The live site evaluated everything with opening_hours.js, so its
//! semantics are the reference; anything outside the subset returns `None`
//! and stays on the crate.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, Timelike};

const DAY: u32 = 1440;

/// Segment tags: 0 plain, `1..OPEN_END_TAG` "matched through `PH` on a
/// holiday" (one value per date), `OPEN_END_TAG` an open end's guessed span,
/// above it one per commented rule. opening_hours.js attaches the holiday
/// name or rule comment to the state, and `getNextChange` stops wherever
/// that comment changes - even when open/closed doesn't, and between two
/// consecutive holidays.
const OPEN_END_TAG: u32 = 1 << 20;

/// Holiday tag for a date (distinct for neighbouring days).
fn holiday_tag(date: NaiveDate) -> u32 {
    1 + (date.num_days_from_ce() as u32 % (OPEN_END_TAG - 1))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Open,
    Closed,
    /// Commented rules and open ends. Callers show it as closed (like
    /// `getState()`), but its boundaries are still state changes.
    Unknown,
}

/// Half-open minute range. Closed time is normally a gap; it only appears as
/// a segment when tagged, so its end still counts as a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Seg {
    pub start: u32,
    pub end: u32,
    pub kind: Kind,
    pub tag: u32,
}

#[derive(Debug, Clone)]
struct Rule {
    /// Bit per weekday, Monday = bit 0.
    days: u8,
    ph: bool,
    /// `PH Su` (no comma): a holiday that falls on one of `days`.
    ph_and_days: bool,
    /// Minutes from the rule's day start; `end` may exceed a day (spill).
    spans: Vec<Seg>,
    closes: bool,
    /// Adds to the day instead of replacing it. opening_hours.js does this for
    /// `,`-joined rules and for rules without a day selector
    /// (`Mo-Fr 08:00-12:00; 14:00-18:00` keeps both spans on weekdays).
    additive: bool,
}

impl Rule {
    /// `None` when the rule doesn't select the day; otherwise the tag its
    /// segments carry there.
    fn matches(&self, weekday: u32, holiday: Option<u32>) -> Option<u32> {
        let on_day = self.days & (1 << weekday) != 0;
        let by_ph = if self.ph { holiday } else { None };
        let hit = if self.ph_and_days {
            on_day && by_ph.is_some()
        } else {
            (self.days == 0 && !self.ph) || on_day || by_ph.is_some()
        };
        hit.then_some(by_ph.unwrap_or(0))
    }

    /// Like [`Self::matches`] for the previous day's spill past midnight. The
    /// holiday name stays on the holiday itself.
    fn spills_from(&self, weekday: u32, holiday: Option<u32>) -> Option<u32> {
        self.matches(weekday, holiday).map(|tag| if tag < OPEN_END_TAG { 0 } else { tag })
    }
}

#[derive(Debug, Clone)]
pub struct Weekly {
    rules: Vec<Rule>,
    /// `A || B`: B applies on days no rule of A selects.
    fallback: Vec<Rule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tok {
    Day(u8),
    Ph,
    Time(u32),
    Always,
    Dash,
    Plus,
    Comma,
    Semi,
    Fallback,
    Comment,
    Kind(Kind),
}

fn tokenize(raw: &str) -> Option<Vec<Tok>> {
    let b = raw.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        match c {
            _ if c.is_ascii_whitespace() => i += 1,
            b'-' | b'+' | b',' | b';' => {
                out.push(match c {
                    b'-' => Tok::Dash,
                    b'+' => Tok::Plus,
                    b',' => Tok::Comma,
                    _ => Tok::Semi,
                });
                i += 1;
            }
            b'|' if b.get(i + 1) == Some(&b'|') => {
                out.push(Tok::Fallback);
                i += 2;
            }
            b'"' => {
                let close = raw[i + 1..].find('"')?;
                out.push(Tok::Comment);
                i += close + 2;
            }
            b'0'..=b'9' => {
                if raw[i..].starts_with("24/7") {
                    out.push(Tok::Always);
                    i += 4;
                    continue;
                }
                let mut j = i;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                let minutes_ok = j + 2 < b.len()
                    && b[j] == b':'
                    && b[j + 1].is_ascii_digit()
                    && b[j + 2].is_ascii_digit()
                    && b.get(j + 3).is_none_or(|d| !d.is_ascii_digit());
                if j - i > 2 || !minutes_ok {
                    return None;
                }
                let h: u32 = raw[i..j].parse().ok()?;
                let m: u32 = raw[j + 1..j + 3].parse().ok()?;
                if h > 48 || m > 59 {
                    return None;
                }
                out.push(Tok::Time(h * 60 + m));
                i = j + 3;
            }
            _ if c.is_ascii_alphabetic() => {
                let mut j = i;
                while j < b.len() && b[j].is_ascii_alphabetic() {
                    j += 1;
                }
                // opening_hours.js auto-corrects case and English, German and
                // French day names; these are the spellings it maps to one day
                // (it reads `Ma` as Monday; `Me`/`Di` stay unsupported).
                out.push(match raw[i..j].to_ascii_lowercase().as_str() {
                    "mo" | "mon" | "lu" | "ma" => Tok::Day(0),
                    "tu" | "tue" => Tok::Day(1),
                    "we" | "wed" | "mi" => Tok::Day(2),
                    "th" | "thu" | "do" | "je" => Tok::Day(3),
                    "fr" | "fri" | "ve" => Tok::Day(4),
                    "sa" | "sat" => Tok::Day(5),
                    "su" | "sun" | "so" => Tok::Day(6),
                    "ph" => Tok::Ph,
                    "off" | "closed" => Tok::Kind(Kind::Closed),
                    "open" => Tok::Kind(Kind::Open),
                    "unknown" => Tok::Kind(Kind::Unknown),
                    _ => return None,
                });
                i = j;
            }
            _ => return None,
        }
    }
    Some(out)
}

fn day_mask(from: u8, to: u8) -> u8 {
    let mut mask = 0;
    let mut d = from;
    loop {
        mask |= 1 << d;
        if d == to {
            return mask;
        }
        d = (d + 1) % 7;
    }
}

/// Where an open end (`18:00+`) stops being "unknown" - opening_hours.js's
/// fixed guesses.
fn open_end(from: u32) -> u32 {
    if from >= 22 * 60 {
        from + 8 * 60
    } else if from >= 17 * 60 {
        from + 10 * 60
    } else {
        DAY
    }
}

/// Weekday list (`Mo-Fr,Su`, `PH`) at `i`: (day mask, PH, next index).
fn parse_days(t: &[Tok], mut i: usize) -> Option<(u8, bool, usize)> {
    let mut days = 0u8;
    let mut ph = false;
    loop {
        match t.get(i) {
            Some(&Tok::Day(a)) => {
                if t.get(i + 1) == Some(&Tok::Dash) {
                    let Some(&Tok::Day(b)) = t.get(i + 2) else { return None };
                    days |= day_mask(a, b);
                    i += 3;
                } else {
                    days |= 1 << a;
                    i += 1;
                }
            }
            Some(Tok::Ph) => {
                ph = true;
                i += 1;
            }
            _ => break,
        }
        if t.get(i) == Some(&Tok::Comma) && matches!(t.get(i + 1), Some(Tok::Day(_) | Tok::Ph)) {
            i += 1;
        } else {
            break;
        }
    }
    Some((days, ph, i))
}

/// One rule starting at `i`; returns it and the index of the token after it
/// (end of group or a `,` that opens an additional rule).
fn parse_rule(t: &[Tok], i: usize, additional: bool, comment_tag: u32) -> Option<(Rule, usize)> {
    let (mut days, ph, mut i) = parse_days(t, i)?;
    let mut ph_and_days = false;
    if ph && days == 0 && matches!(t.get(i), Some(Tok::Day(_))) {
        let (d, extra_ph, next) = parse_days(t, i)?;
        if extra_ph {
            return None;
        }
        days = d;
        ph_and_days = true;
        i = next;
    }
    let has_days = days != 0 || ph;

    let mut spans = Vec::new();
    let open = |start, end| Seg { start, end, kind: Kind::Open, tag: 0 };
    if t.get(i) == Some(&Tok::Always) {
        spans.push(open(0, DAY));
        i += 1;
    } else {
        while let Some(&Tok::Time(a)) = t.get(i) {
            if a >= DAY {
                return None;
            }
            match (t.get(i + 1), t.get(i + 2)) {
                (Some(Tok::Dash), Some(&Tok::Time(b))) => {
                    // An end at or before the start wraps past midnight
                    // (`18:00-08:00`, `10:00-10:00` = 24 h).
                    let end = if b <= a { b + DAY } else { b };
                    spans.push(open(a, end));
                    i += 3;
                    if t.get(i) == Some(&Tok::Plus) {
                        spans.push(Seg { start: end, end: open_end(end), kind: Kind::Unknown, tag: OPEN_END_TAG });
                        i += 1;
                    }
                }
                (Some(Tok::Plus), _) => {
                    spans.push(Seg { start: a, end: open_end(a), kind: Kind::Unknown, tag: OPEN_END_TAG });
                    i += 2;
                }
                _ => return None,
            }
            // `08:00-12:00 13:30-17:30` (no comma) is a list too in opening_hours.js.
            if t.get(i) == Some(&Tok::Comma) && matches!(t.get(i + 1), Some(Tok::Time(_))) {
                i += 1;
            } else if !matches!(t.get(i), Some(Tok::Time(_))) {
                break;
            }
        }
    }

    let kind = match t.get(i) {
        Some(&Tok::Kind(k)) => {
            i += 1;
            Some(k)
        }
        _ => None,
    };
    let commented = t.get(i) == Some(&Tok::Comment);
    if commented {
        i += 1;
    }
    if !has_days && spans.is_empty() && kind.is_none() && !commented {
        return None;
    }
    // `Tu,Th, 14:30-17:30`: opening_hours.js rejects a `,` right after a bare
    // day list; refuse rather than guess.
    if spans.is_empty() && kind.is_none() && !commented && t.get(i) == Some(&Tok::Comma) {
        return None;
    }
    match t.get(i) {
        None | Some(Tok::Comma) => {}
        _ => return None,
    }
    if spans.is_empty() {
        spans.push(open(0, DAY));
    }
    // An explicit state wins; a bare comment turns the rule "unknown".
    let forced = kind.or(commented.then_some(Kind::Unknown));
    for s in &mut spans {
        if let Some(k) = forced {
            if k != Kind::Open || s.kind == Kind::Open {
                s.kind = k;
            }
        }
        if commented {
            s.tag = comment_tag;
        }
    }
    let rule = Rule {
        days,
        ph,
        ph_and_days,
        spans,
        closes: forced == Some(Kind::Closed),
        additive: additional || !has_days,
    };
    Some((rule, i))
}

fn parse_group(toks: &[Tok], rules: &mut Vec<Rule>) -> Option<()> {
    for group in toks.split(|t| *t == Tok::Semi) {
        if group.is_empty() {
            continue;
        }
        let mut i = 0;
        let mut additional = false;
        loop {
            // Distinct per rule so two adjacent commented rules still change.
            let comment_tag = OPEN_END_TAG + 1 + rules.len() as u32;
            let (rule, next) = parse_rule(group, i, additional, comment_tag)?;
            rules.push(rule);
            if next == group.len() {
                break;
            }
            i = next + 1;
            additional = true;
        }
    }
    Some(())
}

impl Weekly {
    /// `None` when the rule uses anything outside the supported subset.
    pub fn parse(raw: &str) -> Option<Self> {
        let toks = tokenize(raw)?;
        let mut parts = toks.split(|t| *t == Tok::Fallback);
        let mut rules = Vec::new();
        parse_group(parts.next()?, &mut rules)?;
        let primary = rules.len();
        if let Some(p) = parts.next() {
            parse_group(p, &mut rules)?;
        }
        if parts.next().is_some() || primary == 0 {
            return None;
        }
        let fallback = rules.split_off(primary);
        Some(Self { rules, fallback })
    }

    /// Segments within one day (minutes, half-open, sorted), given that day's
    /// and the previous day's weekday and holiday status.
    fn day(&self, weekday: u32, holiday: Option<u32>, prev_weekday: u32, prev_holiday: Option<u32>) -> Vec<Seg> {
        let mut cur = Vec::new();
        let mut closed_by_rule = false;
        for r in &self.rules {
            let own = r.matches(weekday, holiday);
            closed_by_rule |= own.is_some() && r.closes;
            apply_rule(&mut cur, r, own, r.spills_from(prev_weekday, prev_holiday));
        }
        // `A || B`: B covers whatever time A leaves unmatched, unless A
        // explicitly closed the day.
        if !self.fallback.is_empty() && !closed_by_rule {
            let mut fb = Vec::new();
            for r in &self.fallback {
                apply_rule(&mut fb, r, r.matches(weekday, holiday), None);
            }
            for s in fb {
                let mut from = s.start;
                for c in cur.clone() {
                    if c.start > from {
                        paint(&mut cur, Seg { start: from, end: c.start.min(s.end), ..s });
                    }
                    from = from.max(c.end);
                }
                paint(&mut cur, Seg { start: from, ..s });
            }
        }
        cur
    }

    /// Segments (minutes from `from` 00:00) over `days` days, touching
    /// segments with the same kind and tag merged.
    pub fn intervals(&self, from: NaiveDate, days: u32, is_holiday: impl Fn(NaiveDate) -> bool) -> Vec<Seg> {
        let mut out: Vec<Seg> = Vec::new();
        let mut prev = from - Duration::days(1);
        let tag_of = |d: NaiveDate| is_holiday(d).then(|| holiday_tag(d));
        let mut prev_hol = tag_of(prev);
        for d in 0..days {
            let date = from + Duration::days(d as i64);
            let hol = tag_of(date);
            let base = d * DAY;
            let wd = date.weekday().num_days_from_monday();
            for s in self.day(wd, hol, prev.weekday().num_days_from_monday(), prev_hol) {
                match out.last_mut() {
                    Some(last) if last.end == base + s.start && (last.kind, last.tag) == (s.kind, s.tag) => {
                        last.end = base + s.end
                    }
                    _ => out.push(Seg { start: base + s.start, end: base + s.end, ..s }),
                }
            }
            prev = date;
            prev_hol = hol;
        }
        out
    }

    /// Baked weekly schedule over a holiday-free week (the importer's `week`),
    /// clipped at the week's end like `getOpenIntervals`. `None` when any
    /// part is "unknown" or tagged - the binary search only knows open/closed.
    pub fn week(&self) -> Option<Vec<u32>> {
        let monday = NaiveDate::from_ymd_opt(2024, 1, 15).unwrap_or_default();
        let week = 7 * DAY;
        let segs = self.intervals(monday, 7, |_| false);
        if segs.iter().any(|s| s.kind != Kind::Open || s.tag != 0) {
            return None;
        }
        Some(segs.into_iter().filter(|s| s.start < week).flat_map(|s| [s.start, s.end.min(week)]).collect())
    }

    /// Open at `now` (unknown counts as not open), and the next change within
    /// two weeks (`None` when nothing changes that long).
    pub fn state_at(&self, now: NaiveDateTime, is_holiday: impl Fn(NaiveDate) -> bool) -> (bool, Option<NaiveDateTime>) {
        // A plain weekly rule repeats within 8 days; a `PH` rule can change
        // only at the next holiday, which may be months out.
        let horizon_days = if self.rules.iter().chain(&self.fallback).any(|r| r.ph) { 400 } else { 15 };
        let today = now.date();
        let start = today.and_hms_opt(0, 0, 0).unwrap_or(now);
        let minute = now.hour() * 60 + now.minute();
        let horizon = horizon_days * DAY;
        let at = |m: u32| (m < horizon).then(|| start + Duration::minutes(m as i64));
        let segs = self.intervals(today, horizon_days, is_holiday);
        match segs.iter().find(|s| s.end > minute) {
            Some(s) if s.start <= minute => (s.kind == Kind::Open, at(s.end)),
            Some(s) => (false, at(s.start)),
            None => (false, None),
        }
    }
}

fn apply_rule(cur: &mut Vec<Seg>, r: &Rule, own: Option<u32>, spill: Option<u32>) {
    if own.is_none() && spill.is_none() {
        return;
    }
    if own.is_some() && !r.closes && !r.additive {
        cur.clear();
    }
    for s in &r.spans {
        // A rule's own comment (open end, quoted text) wins over the holiday name.
        let tagged = |day_tag: u32| Seg { tag: if s.tag != 0 { s.tag } else { day_tag }, ..*s };
        if let Some(tag) = own {
            paint(cur, Seg { end: s.end.min(DAY), ..tagged(tag) });
        }
        if let Some(tag) = spill.filter(|_| s.end > DAY) {
            paint(cur, Seg { start: s.start.saturating_sub(DAY), end: (s.end - DAY).min(DAY), ..tagged(tag) });
        }
    }
}

/// Overwrite `[seg.start, seg.end)`; untagged closed just cuts it out.
fn paint(cur: &mut Vec<Seg>, seg: Seg) {
    let (a, b) = (seg.start, seg.end);
    if a >= b {
        return;
    }
    let mut next = Vec::with_capacity(cur.len() + 2);
    for &s in cur.iter() {
        if s.end <= a || s.start >= b {
            next.push(s);
            continue;
        }
        if s.start < a {
            next.push(Seg { end: a, ..s });
        }
        if s.end > b {
            next.push(Seg { start: b, ..s });
        }
    }
    if seg.kind != Kind::Closed || seg.tag != 0 {
        let pos = next.partition_point(|s| s.start < a);
        next.insert(pos, seg);
    }
    next.dedup_by(|b, a| {
        let touch = a.end == b.start && (a.kind, a.tag) == (b.kind, b.tag);
        if touch {
            a.end = b.end;
        }
        touch
    });
    *cur = next;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn week(raw: &str) -> Vec<u32> {
        Weekly::parse(raw).unwrap_or_else(|| panic!("unsupported: {raw}")).week().expect("bakeable")
    }

    fn state(raw: &str, now: NaiveDateTime, holiday: Option<NaiveDate>) -> (bool, Option<NaiveDateTime>) {
        Weekly::parse(raw).unwrap().state_at(now, |d| Some(d) == holiday)
    }

    fn dt(d: u32, h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, d).unwrap().and_hms_opt(h, m, 0).unwrap()
    }

    /// Sat 2026-10-03, Tag der Deutschen Einheit.
    fn unity_day() -> Option<NaiveDate> {
        NaiveDate::from_ymd_opt(2026, 10, 3)
    }

    // Expected values below were produced by opening_hours.js 3.12
    // (`getOpenIntervals` over Mon 2024-01-15 … Mon 2024-01-22 and
    // `getState`/`getNextChange`, TZ=UTC).

    #[test]
    fn overnight_spill_survives_later_rules_for_the_next_day() {
        assert_eq!(
            week("Mo-Fr 06:30-01:00; Sa-Su 07:30-01:00"),
            [0, 60, 390, 1500, 1830, 2940, 3270, 4380, 4710, 5820, 6150, 7200, 7650, 8700, 9090, 10080]
        );
        assert_eq!(week("Tu 09:00-02:00; Mo 09:00-02:00"), [540, 1560, 1980, 3000]);
    }

    #[test]
    fn overriding_rule_clears_earlier_spill_into_its_day() {
        assert_eq!(week("We 22:00-02:00; Th off"), [4200, 4320]);
        assert_eq!(week("We 22:00-02:00; Th 10:00-12:00"), [4200, 4320, 4920, 5040]);
        assert_eq!(
            week("Mo-Fr 20:00-02:00; We 10:00-12:00"),
            [1200, 1560, 2640, 2880, 3480, 3600, 4320, 4440, 5520, 5880, 6960, 7320]
        );
    }

    #[test]
    fn additional_and_time_only_rules_add() {
        assert_eq!(week("Mo 22:00-02:00, Tu 01:00-05:00"), [1320, 1740]);
        assert_eq!(week("Mo 22:00-02:00; Tu off, Tu 10:00-11:00"), [1320, 1440, 2040, 2100]);
        assert_eq!(
            week("Mo-Fr 08:00-12:00; 14:00-18:00"),
            [480, 720, 840, 1080, 1920, 2160, 2280, 2520, 3360, 3600, 3720, 3960, 4800, 5040, 5160, 5400, 6240,
                6480, 6600, 6840, 8040, 8280, 9480, 9720]
        );
        assert_eq!(
            week("14:00-18:00; Mo-Fr 08:00-12:00"),
            [480, 720, 1920, 2160, 3360, 3600, 4800, 5040, 6240, 6480, 8040, 8280, 9480, 9720]
        );
    }

    #[test]
    fn off_with_times_subtracts_only_that_span() {
        assert_eq!(
            week("Mo-Fr 08:00-18:00; Tu 10:00-11:00 off"),
            [480, 1080, 1920, 2040, 2100, 2520, 3360, 3960, 4800, 5400, 6240, 6840]
        );
    }

    #[test]
    fn tolerant_spellings_and_wrapping_ranges() {
        assert_eq!(week("Tu, We, Th, Fr 08:00 - 18:00"), [1920, 2520, 3360, 3960, 4800, 5400, 6240, 6840]);
        assert_eq!(week("Mo - Fr 09:00 - 12:00"), [540, 720, 1980, 2160, 3420, 3600, 4860, 5040, 6300, 6480]);
        assert_eq!(week("Mon-Thu 07:00-12:30"), [420, 750, 1860, 2190, 3300, 3630, 4740, 5070]);
        assert_eq!(week("Mo 08:00-12:00 13:30-17:30"), [480, 720, 810, 1050]);
        assert_eq!(week("Fr-Mo 22:00-03:00"), [0, 180, 1320, 1620, 7080, 7380, 8520, 8820, 9960, 10080]);
        assert_eq!(week("Mo 10:00-10:00"), [600, 2040]);
        assert_eq!(week("Mo-Sa 24/7"), [0, 8640]);
        assert_eq!(week("24/7"), [0, 10080]);
    }

    #[test]
    fn rejects_what_it_cannot_reproduce() {
        for raw in ["Tu,Th, 14:30-17:30", "Mo-Fr sunrise-sunset", "SH off", "Mo[1] off", "Apr-Oct Mo 10:00-12:00"] {
            assert!(Weekly::parse(raw).is_none(), "{raw}");
        }
    }

    #[test]
    fn holidays_close_and_their_name_ends_at_midnight() {
        let raw = "Mo-Sa 08:00-20:00; Su,PH off";
        assert_eq!(state(raw, dt(3, 12, 0), unity_day()), (false, Some(dt(4, 0, 0))));
        assert_eq!(state(raw, dt(3, 12, 0), None), (true, Some(dt(3, 20, 0))));
        assert_eq!(state(raw, dt(4, 12, 0), unity_day()), (false, Some(dt(5, 8, 0))));
        assert_eq!(state("Mo-Sa 08:00-20:00; ph off", dt(3, 12, 0), unity_day()).0, false);
    }

    #[test]
    fn additional_holiday_spans_add_but_still_mark_changes() {
        let raw = "Mo-Su 09:00-23:30, PH 14:00-20:00";
        assert_eq!(state(raw, dt(3, 12, 0), unity_day()), (true, Some(dt(3, 14, 0))));
        assert_eq!(state(raw, dt(3, 15, 0), unity_day()), (true, Some(dt(3, 20, 0))));
        assert_eq!(state(raw, dt(3, 21, 0), unity_day()), (true, Some(dt(3, 23, 30))));
        assert_eq!(state("Sa 07:00-20:00, PH 07:00-18:00", dt(3, 12, 0), unity_day()), (true, Some(dt(3, 18, 0))));
    }

    #[test]
    fn ph_followed_by_days_means_holiday_on_those_days() {
        let raw = "Mo-Fr 07:00-20:00; Sa 08:00-16:00; PH Su off";
        assert_eq!(state(raw, dt(3, 12, 0), unity_day()), (true, Some(dt(3, 16, 0))));
    }

    #[test]
    fn comments_and_open_ends_are_unknown_but_still_change_state() {
        assert_eq!(state("\"nach Vereinbarung\"", dt(7, 13, 15), None), (false, None));
        // Unknown 10:00-18:00 on Sunday; Saturday noon waits for its end.
        assert_eq!(state("Su 10:00-18:00 \"Kalender\"", dt(4, 12, 0), None), (false, Some(dt(4, 18, 0))));
        assert_eq!(state("Mo-Su 11:00-18:00+", dt(7, 13, 15), None), (true, Some(dt(7, 18, 0))));
        // 18:00+ stays unknown for ten hours.
        assert_eq!(state("Mo-Su 11:00-18:00+", dt(5, 0, 30), None), (false, Some(dt(5, 4, 0))));
        assert_eq!(state("Mo-Su 16:00+", dt(7, 18, 0), None), (false, Some(dt(8, 0, 0))));
        assert_eq!(
            state("Mo-Su 10:00-21:00||\"bei schlechtem Wetter geschlossen\"", dt(7, 13, 15), None),
            (true, Some(dt(7, 21, 0)))
        );
        assert!(Weekly::parse("Mo-Su 16:00+").unwrap().week().is_none());
    }
}
