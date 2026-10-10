//! GitHub PR helpers on top of [`super::github_app`]. Port of
//! `src/lib/github-pr.ts`.
//!
//! `propose_change` runs the whole dance — read file → mutate → commit on a
//! fresh branch → open PR — so moderation only passes a mutator. Falls back
//! gracefully when no App creds are configured (returns `None`, caller marks
//! the row approved so moderator intent isn't lost).

use worker::{Env, Method, Response, Result};

use super::github_app::{
    self, CreatedIssue, DATA_REPO_NAME, DATA_REPO_OWNER, DEFAULT_BRANCH, authed_fetch,
};

#[derive(Debug, Clone, PartialEq)]
pub struct CreatedPr {
    pub number: i64,
    pub html_url: String,
}

/// Terminal upstream state of something we opened on the data repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamOutcome {
    Merged,
    Dismissed,
}

impl UpstreamOutcome {
    pub fn as_status(self) -> &'static str {
        match self {
            UpstreamOutcome::Merged => "merged",
            UpstreamOutcome::Dismissed => "dismissed",
        }
    }
}

struct FileGet {
    content: String,
    #[allow(dead_code)]
    sha: String,
}

async fn get_branch_sha(token: &str, branch: &str) -> Result<String> {
    let mut resp = authed_fetch(
        token,
        &format!("/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/git/ref/heads/{branch}"),
        Method::Get,
        None,
    )
    .await?;
    if resp.status_code() != 200 {
        return Err(worker::Error::RustError(format!(
            "getBranchSha {branch}: HTTP {}",
            resp.status_code()
        )));
    }
    let data: serde_json::Value = resp.json().await?;
    data.pointer("/object/sha")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| worker::Error::RustError(format!("getBranchSha {branch}: no sha")))
}

/// Read a file from a ref.
///
/// The Contents API caps inline `content` at 1MB — files larger than that
/// come back with `encoding: "none"` and an empty `content`, blob SHA on
/// the side. For those the bytes come from the Git Data API's blob endpoint
/// (100MB limit, plenty for our geojsons).
async fn get_file(token: &str, path: &str, reference: &str) -> Result<Option<FileGet>> {
    let encoded = path.replace('/', "%2F");
    let mut resp = authed_fetch(
        token,
        &format!(
            "/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/contents/{encoded}?ref={}",
            reference.replace('/', "%2F")
        ),
        Method::Get,
        None,
    )
    .await?;
    if resp.status_code() == 404 {
        return Ok(None);
    }
    if resp.status_code() != 200 {
        return Err(worker::Error::RustError(format!(
            "getFile {path}: HTTP {}",
            resp.status_code()
        )));
    }
    let data: serde_json::Value = resp.json().await?;
    let sha = data
        .get("sha")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned();
    match data.get("encoding").and_then(|v| v.as_str()) {
        Some("base64") => Ok(Some(FileGet {
            content: atob_utf8(
                data.get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default(),
            )?,
            sha,
        })),
        Some("none") => {
            let content = get_blob_content(token, &sha).await?;
            Ok(Some(FileGet { content, sha }))
        }
        other => Err(worker::Error::RustError(format!(
            "getFile {path}: unexpected encoding {other:?}"
        ))),
    }
}

async fn get_blob_content(token: &str, blob_sha: &str) -> Result<String> {
    let mut resp = authed_fetch(
        token,
        &format!("/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/git/blobs/{blob_sha}"),
        Method::Get,
        None,
    )
    .await?;
    if resp.status_code() != 200 {
        return Err(worker::Error::RustError(format!(
            "getBlob {blob_sha}: HTTP {}",
            resp.status_code()
        )));
    }
    let data: serde_json::Value = resp.json().await?;
    if data.get("encoding").and_then(|v| v.as_str()) != Some("base64") {
        return Err(worker::Error::RustError(format!(
            "getBlob {blob_sha}: unexpected encoding"
        )));
    }
    atob_utf8(
        data.get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default(),
    )
}

/// Write a file change on a fresh branch using the Git Data API.
///
/// The Contents PUT endpoint has the same 1MB limit as the Contents GET, so
/// for the larger region files this drops to the explicit blob → tree →
/// commit → ref dance: 4 round-trips instead of 1, but unconstrained by file
/// size and no size-class branching in every caller.
async fn commit_file_on_new_branch(
    token: &str,
    path: &str,
    branch: &str,
    base_commit_sha: &str,
    content: &str,
    message: &str,
) -> Result<()> {
    // 1. Upload the new file content as a blob.
    let mut resp = authed_fetch(
        token,
        &format!("/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/git/blobs"),
        Method::Post,
        Some(&serde_json::json!({ "content": content, "encoding": "utf-8" }).to_string()),
    )
    .await?;
    if resp.status_code() != 200 && resp.status_code() != 201 {
        return Err(http_error(&mut resp, "createBlob").await);
    }
    let blob: serde_json::Value = resp.json().await?;
    let blob_sha = blob.get("sha").and_then(|v| v.as_str()).unwrap_or_default();

    // 2. Get the base commit's tree SHA so we can build a delta tree.
    let mut resp = authed_fetch(
        token,
        &format!("/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/git/commits/{base_commit_sha}"),
        Method::Get,
        None,
    )
    .await?;
    if resp.status_code() != 200 {
        return Err(http_error(&mut resp, &format!("getCommit {base_commit_sha}")).await);
    }
    let base_commit: serde_json::Value = resp.json().await?;
    let base_tree = base_commit
        .pointer("/tree/sha")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    // 3. Create a tree that's `base_tree` plus our single-file change.
    let mut resp = authed_fetch(
        token,
        &format!("/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/git/trees"),
        Method::Post,
        Some(
            &serde_json::json!({
                "base_tree": base_tree,
                "tree": [{ "path": path, "mode": "100644", "type": "blob", "sha": blob_sha }],
            })
            .to_string(),
        ),
    )
    .await?;
    if resp.status_code() != 200 && resp.status_code() != 201 {
        return Err(http_error(&mut resp, "createTree").await);
    }
    let tree: serde_json::Value = resp.json().await?;
    let tree_sha = tree.get("sha").and_then(|v| v.as_str()).unwrap_or_default();

    // 4. Wrap that tree in a commit, parented on the base commit.
    let mut resp = authed_fetch(
        token,
        &format!("/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/git/commits"),
        Method::Post,
        Some(
            &serde_json::json!({
                "message": message,
                "tree": tree_sha,
                "parents": [base_commit_sha],
            })
            .to_string(),
        ),
    )
    .await?;
    if resp.status_code() != 200 && resp.status_code() != 201 {
        return Err(http_error(&mut resp, "createCommit").await);
    }
    let commit: serde_json::Value = resp.json().await?;
    let commit_sha = commit
        .get("sha")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    // 5. Create the branch ref pointing at the new commit. 422 = ref already
    //    exists from a prior failed attempt; force-update it so retries don't
    //    leave us stuck with stale state.
    let mut resp = authed_fetch(
        token,
        &format!("/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/git/refs"),
        Method::Post,
        Some(
            &serde_json::json!({ "ref": format!("refs/heads/{branch}"), "sha": commit_sha })
                .to_string(),
        ),
    )
    .await?;
    if resp.status_code() == 200 || resp.status_code() == 201 {
        return Ok(());
    }
    if resp.status_code() != 422 {
        return Err(http_error(&mut resp, &format!("createRef {branch}")).await);
    }
    let mut patch = authed_fetch(
        token,
        &format!("/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/git/refs/heads/{branch}"),
        Method::Patch,
        Some(&serde_json::json!({ "sha": commit_sha, "force": true }).to_string()),
    )
    .await?;
    if patch.status_code() != 200 {
        return Err(http_error(&mut patch, &format!("updateRef {branch}")).await);
    }
    Ok(())
}

async fn open_pr(token: &str, branch: &str, title: &str, body: &str) -> Result<CreatedPr> {
    let mut resp = authed_fetch(
        token,
        &format!("/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/pulls"),
        Method::Post,
        Some(
            &serde_json::json!({
                "title": title,
                "body": body,
                "head": branch,
                "base": DEFAULT_BRANCH,
                "draft": false,
            })
            .to_string(),
        ),
    )
    .await?;
    if resp.status_code() != 200 && resp.status_code() != 201 {
        return Err(http_error(&mut resp, "openPr").await);
    }
    let data: serde_json::Value = resp.json().await?;
    Ok(CreatedPr {
        number: data.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
        html_url: data
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
    })
}

async fn http_error(resp: &mut Response, what: &str) -> worker::Error {
    let status = resp.status_code();
    let body = resp.text().await.unwrap_or_default();
    worker::Error::RustError(format!(
        "{what}: HTTP {status}: {}",
        body.chars().take(200).collect::<String>()
    ))
}

/// Resolve the current state of a PR or issue we previously opened.
///
/// `pr_url` is whatever `open_pr`/`open_issue_via_pr` handed back, so both
/// the number and the kind are recoverable from the path (`/pull/123` vs
/// `/issues/123`). Issues carry no merge concept: a closed one means a
/// moderator dealt with it by hand, which is the same terminal "applied"
/// state as a merged PR. A PR closed without `merged_at` is a rejection.
///
/// Returns `None` while still open and on any lookup failure — callers treat
/// that as "no decision yet" rather than guessing.
pub async fn fetch_upstream_outcome(env: &Env, pr_url: &str) -> Result<Option<UpstreamOutcome>> {
    if !github_app::has_github_app_creds(env) {
        return Ok(None);
    }
    let Some((is_pr, number)) = parse_pr_url(pr_url) else {
        return Ok(None);
    };
    let token = github_app::get_installation_token(env).await?;
    let mut resp = authed_fetch(
        &token,
        &format!(
            "/repos/{DATA_REPO_OWNER}/{DATA_REPO_NAME}/{}/{number}",
            if is_pr { "pulls" } else { "issues" }
        ),
        Method::Get,
        None,
    )
    .await?;
    if resp.status_code() != 200 {
        worker::console_error!("fetchUpstreamOutcome {pr_url}: HTTP {}", resp.status_code());
        return Ok(None);
    }
    let data: serde_json::Value = resp.json().await?;
    if data.get("state").and_then(|v| v.as_str()) != Some("closed") {
        return Ok(None);
    }
    if !is_pr {
        return Ok(Some(UpstreamOutcome::Merged));
    }
    Ok(Some(
        if data.get("merged_at").map(|v| !v.is_null()).unwrap_or(false) {
            UpstreamOutcome::Merged
        } else {
            UpstreamOutcome::Dismissed
        },
    ))
}

/// `…/pull/123…` → `(true, 123)`; `…/issues/123…` → `(false, 123)`.
pub fn parse_pr_url(pr_url: &str) -> Option<(bool, i64)> {
    let (is_pr, rest) = if let Some(i) = pr_url.find("/pull/") {
        (true, &pr_url[i + "/pull/".len()..])
    } else if let Some(i) = pr_url.find("/issues/") {
        (false, &pr_url[i + "/issues/".len()..])
    } else {
        return None;
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    // A number must be followed by end-of-URL or a separator, not more text.
    let tail = &rest[digits.len()..];
    if digits.is_empty()
        || !(tail.is_empty()
            || tail.starts_with('/')
            || tail.starts_with('?')
            || tail.starts_with('#'))
    {
        return None;
    }
    digits.parse().ok().map(|n| (is_pr, n))
}

pub async fn open_issue_via_pr(
    env: &Env,
    title: &str,
    body: &str,
    labels: Option<&[String]>,
) -> Result<Option<CreatedPr>> {
    let Some(issue) = github_app::open_issue(env, title, body, labels).await? else {
        return Ok(None);
    };
    Ok(Some(CreatedPr {
        number: issue.number,
        html_url: issue.html_url,
    }))
}

/// One-shot "propose a change to a single file" helper:
/// fetch the file from `main`, run `mutate`, skip when there is no diff,
/// commit on `branch`, open a PR.
pub async fn propose_change<F>(
    env: &Env,
    path: &str,
    branch: &str,
    commit_message: &str,
    pr_title: &str,
    pr_body: &str,
    mutate: F,
) -> Result<Option<CreatedPr>>
where
    F: FnOnce(&str) -> Result<String>,
{
    if !github_app::has_github_app_creds(env) {
        return Ok(None);
    }
    let token = github_app::get_installation_token(env).await?;
    let Some(file) = get_file(&token, path, DEFAULT_BRANCH).await? else {
        return Err(worker::Error::RustError(format!(
            "Target file does not exist on {DEFAULT_BRANCH}: {path}"
        )));
    };
    let next = mutate(&file.content)?;
    if next == file.content {
        return Ok(None);
    }

    let base_commit_sha = get_branch_sha(&token, DEFAULT_BRANCH).await?;
    commit_file_on_new_branch(
        &token,
        path,
        branch,
        &base_commit_sha,
        &next,
        commit_message,
    )
    .await?;
    Ok(Some(open_pr(&token, branch, pr_title, pr_body).await?))
}

/// base64 decode that survives non-ASCII (German umlauts in the data).
fn atob_utf8(b64: &str) -> Result<String> {
    let cleaned: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = crate::crypto::base64_decode(&cleaned)
        .ok_or_else(|| worker::Error::RustError("invalid base64 from GitHub".into()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[allow(dead_code)]
fn _issue_type(_: CreatedIssue) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_url_parsing_matches_the_ts_regex() {
        assert_eq!(
            parse_pr_url("https://github.com/a/b/pull/123"),
            Some((true, 123))
        );
        assert_eq!(
            parse_pr_url("https://github.com/a/b/issues/9"),
            Some((false, 9))
        );
        assert_eq!(
            parse_pr_url("https://github.com/a/b/pull/123/files"),
            Some((true, 123))
        );
        assert_eq!(
            parse_pr_url("https://github.com/a/b/issues/9#x"),
            Some((false, 9))
        );
        assert_eq!(parse_pr_url("https://github.com/a/b/pull/"), None);
        assert_eq!(parse_pr_url("https://github.com/a/b/pulls/123"), None);
        assert_eq!(parse_pr_url("https://example.com/nope"), None);
    }

    #[test]
    fn atob_utf8_round_trip() {
        let s = "Trinkhalle Eichenloh – Straße";
        assert_eq!(
            atob_utf8(&crate::crypto::base64_encode(s.as_bytes())).unwrap(),
            s
        );
    }
}
