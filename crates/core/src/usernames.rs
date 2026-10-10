//! Handle validation and themed generation.
//!
//! Handles look like `pfand_pirat_4821`: two nouns (a Späti word colouring a
//! persona — German adjectives would have to decline, nouns don't), plus a
//! random suffix so handles leak neither signup order nor user count. Shape
//! `^[a-z0-9_]{3,24}$`, lowercase only. Uniqueness and the change-once rule are
//! enforced in SQL by the worker.

const RESERVED: [&str; 17] = [
    "me", "moderate", "auth", "api", "k", "stadt", "add", "about", "admin", "moderator", "support", "help",
    "official", "trinkhallen", "system", "anonymous", "deleted",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalid {
    Invalid,
    Reserved,
}

impl Invalid {
    pub fn code(self) -> &'static str {
        match self {
            Invalid::Invalid => "invalid",
            Invalid::Reserved => "reserved",
        }
    }
}

pub fn validate_username(raw: &str) -> Result<String, Invalid> {
    let value = raw.trim().to_lowercase();
    let len = value.chars().count();
    if !(3..=24).contains(&len) || !value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(Invalid::Invalid);
    }
    if RESERVED.contains(&value.as_str()) {
        return Err(Invalid::Reserved);
    }
    Ok(value)
}

pub const PREFIXES: [&str; 34] = [
    "pfand", "wegbier", "mate", "limo", "kiosk", "korn", "pils", "astra", "aeppler", "spaeti", "brause", "hopfen",
    "malz", "nacht", "feier", "durst", "pegel", "tresen", "theke", "deckel", "senf", "pommes", "bier", "schnaps",
    "kippe", "bonbon", "flasche", "stulle", "koffein", "zucker", "sprudel", "spezi", "wodka", "kassen",
];

pub const PERSONAS: [&str; 32] = [
    "pirat", "held", "wicht", "koenig", "fee", "streuner", "kumpel", "nerd", "fuchs", "kobold", "geist", "baron",
    "ritter", "lord", "hai", "ninja", "freund", "meister", "fan", "kenner", "profi", "veteran", "kaiser", "zwerg",
    "schreck", "bandit", "magier", "riese", "kumpan", "schelm", "gnom", "pilot",
];

/// A candidate handle from three random draws (caller supplies randomness so
/// this stays pure; the worker uses `crypto.getRandomValues`).
pub fn handle_candidate(r_prefix: u32, r_persona: u32, r_suffix: u32) -> String {
    format!(
        "{}_{}_{}",
        PREFIXES[(r_prefix as usize) % PREFIXES.len()],
        PERSONAS[(r_persona as usize) % PERSONAS.len()],
        10 + (r_suffix % 9990)
    )
}

/// Wider-suffix fallback after many collisions.
pub fn handle_candidate_wide(r_persona: u32, r_suffix: u32) -> String {
    format!("{}_{}", PERSONAS[(r_persona as usize) % PERSONAS.len()], r_suffix % 1_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation() {
        assert_eq!(validate_username("  Pfand_Pirat_42 "), Ok("pfand_pirat_42".into()));
        assert_eq!(validate_username("ab"), Err(Invalid::Invalid));
        assert_eq!(validate_username("bad-name"), Err(Invalid::Invalid));
        assert_eq!(validate_username("admin"), Err(Invalid::Reserved));
        assert_eq!(validate_username(&"a".repeat(25)), Err(Invalid::Invalid));
    }

    #[test]
    fn candidates_fit() {
        for (a, b, c) in [(0, 0, 0), (33, 31, 9989), (u32::MAX, u32::MAX, u32::MAX)] {
            let h = handle_candidate(a, b, c);
            assert!(validate_username(&h).is_ok(), "{h}");
        }
        assert!(validate_username(&handle_candidate_wide(7, 999_999)).is_ok());
    }
}
