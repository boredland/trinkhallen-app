//! View models the Worker fills from D1 and the static kiosk data.
//! All are serde-serializable so islands can receive them as JSON props.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Moderator,
    Admin,
}

impl Role {
    pub fn parse(s: &str) -> Role {
        match s {
            "moderator" => Role::Moderator,
            "admin" => Role::Admin,
            _ => Role::User,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Moderator => "moderator",
            Role::Admin => "admin",
        }
    }

    pub fn is_moderator(self) -> bool {
        matches!(self, Role::Moderator | Role::Admin)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionUser {
    pub id: String,
    pub email: String,
    pub username: Option<String>,
    pub role: Role,
    /// Created via magic link and no Google/Apple linked yet.
    pub is_magic_link_only: bool,
    pub has_google: bool,
    pub has_apple: bool,
}

/// Public rating aggregate; shadow-banned authors excluded.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct Aggregate {
    /// 0 when `count == 0`.
    pub avg: f64,
    pub count: u32,
    /// Index 0 = number of 1-star ratings.
    pub histogram: [u32; 5],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RatingRow {
    pub stars: u8,
    pub comment: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RatingComment {
    /// Public @handle (or the localized "Anonym" fallback).
    pub author: String,
    pub stars: u8,
    pub comment: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserKioskReport {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub pr_url: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NearbyKiosk {
    pub id: String,
    pub name: String,
    pub district: Option<String>,
    pub distance: f64,
    pub lng: f64,
    pub lat: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Nav {
    Map,
    About,
    Me,
    Moderate,
}
