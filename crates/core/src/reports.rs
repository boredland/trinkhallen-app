//! Report kinds and statuses shared by the API, moderation and the profile page.

/// Kinds a user may file through `POST /api/reports`.
pub const ALLOWED_KINDS: [&str; 8] =
    ["wrong_hours", "wrong_address", "wrong_name", "closed", "duplicate", "update_payment", "update_tags", "other"];

/// Statuses that block filing the same kind again for the same kiosk:
/// waiting for moderation or already accepted. A rejection lets the user retry.
pub const BLOCKING_STATUSES: [&str; 3] = ["open", "pr_opened", "approved"];

/// Kinds `applyReportPatch` can turn into a structured data-file edit.
pub const KNOWN_PATCH_KINDS: [&str; 7] =
    ["wrong_hours", "wrong_address", "wrong_name", "closed", "update_payment", "update_tags", "ph_open_observed"];
