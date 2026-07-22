//! Local web search backend. Currently only the Brave Search API is wired up;
//! the module is structured so alternative providers can land behind the same
//! `WebSearchBackend` trait without changing the tool or command surface.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const BRAVE_SEARCH_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_TIMEOUT_SECS: u64 = 20;
const BRAVE_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 LocusWebSearch/1.0";

/// Maximum number of results the tool will request from the upstream provider.
/// Brave's free tier is 20 results per query; we cap below that to keep token
/// cost on the LLM side predictable.
pub const MAX_RESULTS_CAP_PUBLIC: u32 = 20;
const MAX_RESULTS_CAP: u32 = MAX_RESULTS_CAP_PUBLIC;

/// Shared in-memory state. The Tauri `State` registration and this global
/// pointer reference the same `Arc`, so writes from the settings command are
/// observed immediately by tool-routing code that does not have an
/// `AppHandle` in scope.
pub type SharedState = Arc<RwLock<LocalWebSearchConfig>>;

static GLOBAL_STATE: OnceLock<SharedState> = OnceLock::new();

/// Bind the global state pointer. Call exactly once during app setup. Passing
/// the same `Arc` that you also register with `app.manage()` keeps every
/// reader (tool routing, the execute closure, the settings command) on the
/// same source of truth.
pub fn bind_global_state(state: SharedState) {
    let _ = GLOBAL_STATE.set(state);
}

/// Snapshot of the current configuration. Cheap enough to call per request;
/// the inner `RwLock` is uncontended in practice.
pub async fn current_config() -> LocalWebSearchConfig {
    match GLOBAL_STATE.get() {
        Some(state) => state.read().await.clone(),
        None => LocalWebSearchConfig::default(),
    }
}

/// Whether the tool should be advertised to the LLM. Read by both the tool
/// filter in `agent::instance` (to hide the tool when disabled) and the
/// execute closure (to refuse a stale tool call right after the user
/// toggles the feature off).
pub async fn is_active() -> bool {
    current_config().await.is_active()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalWebSearchConfig {
    pub enabled: bool,
    /// `None` means the user has not provided an API key yet. When `enabled`
    /// is true and this is empty, the tool refuses to run.
    pub brave_api_key: Option<String>,
}

impl Default for LocalWebSearchConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            brave_api_key: None,
        }
    }
}

impl LocalWebSearchConfig {
    /// Whether the tool should be advertised to the LLM and allowed to execute.
    /// The user must explicitly enable the feature AND provide a non-empty key.
    pub fn is_active(&self) -> bool {
        self.enabled
            && self
                .brave_api_key
                .as_ref()
                .map(|k| !k.trim().is_empty())
                .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchResponse {
    pub query: String,
    pub hits: Vec<WebSearchHit>,
}

/// A single result from the upstream search API. We only deserialize the
/// fields we need — Brave's response carries a lot of metadata we ignore.
#[derive(Debug, Deserialize)]
struct BraveApiWebResult {
    title: Option<String>,
    url: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BraveApiResultsBlock {
    web: Option<Vec<BraveApiWebResult>>,
}

#[derive(Debug, Deserialize)]
struct BraveApiResponse {
    #[serde(default)]
    query: Option<String>,
    web: Option<BraveApiResultsBlock>,
}

/// Run a search against the Brave Search API. The caller (the tool wrapper) is
/// responsible for surfacing the error verbatim to the LLM.
///
/// `count` is clamped to `1..=MAX_RESULTS_CAP`. `safesearch` accepts
/// `"strict"`, `"moderate"`, or `"off"`; any other value falls back to
/// `"moderate"`. An empty query short-circuits to a friendly error.
pub async fn brave_search(
    api_key: &str,
    query: &str,
    count: Option<u32>,
    safesearch: Option<&str>,
) -> Result<WebSearchResponse, String> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Err("Error: web_search requires a non-empty `query`.".to_string());
    }
    let trimmed_key = api_key.trim();
    if trimmed_key.is_empty() {
        return Err("Error: web_search is missing a Brave API key.".to_string());
    }

    let count = count
        .unwrap_or(10)
        .clamp(1, MAX_RESULTS_CAP);
    let safesearch = match safesearch.unwrap_or("moderate") {
        "strict" => "strict",
        "off" => "off",
        _ => "moderate",
    };

    let client = crate::network::reqwest_client(
        crate::network::ReqwestClientOptions::new()
            .timeout(Duration::from_secs(BRAVE_TIMEOUT_SECS))
            .user_agent(BRAVE_USER_AGENT)
            .gzip(true)
            .deflate(true),
    )
    .map_err(|e| format!("Error creating HTTP client: {}", e))?;

    let response = client
        .get(BRAVE_SEARCH_ENDPOINT)
        .query(&[
            ("q", trimmed_query),
            ("count", &count.to_string()),
            ("safesearch", safesearch),
        ])
        .header("Accept", "application/json")
        .header("X-Subscription-Token", trimmed_key)
        .send()
        .await
        .map_err(|e| format!("Error sending search request: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let truncated_body: String = body.chars().take(400).collect();
        return Err(format!(
            "Brave Search API returned HTTP {} {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown"),
            truncated_body
        ));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Error reading search response: {}", e))?;
    let parsed: BraveApiResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Error parsing Brave Search response: {}", e))?;

    let hits = parsed
        .web
        .and_then(|w| w.web)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let title = entry.title?;
            let url = entry.url?;
            let snippet = entry.description.unwrap_or_default();
            if title.is_empty() || url.is_empty() {
                return None;
            }
            Some(WebSearchHit {
                title,
                url,
                snippet,
            })
        })
        .take(count as usize)
        .collect();

    Ok(WebSearchResponse {
        query: parsed.query.unwrap_or_else(|| trimmed_query.to_string()),
        hits,
    })
}

/// Render search hits into the plain-text form we hand back to the LLM. We
/// use a numbered markdown-ish list because every downstream LLM is trained
/// on search-result formatting of this shape.
pub fn format_response(response: &WebSearchResponse) -> String {
    if response.hits.is_empty() {
        return format!(
            "No results for query: {}",
            response.query
        );
    }

    let mut out = format!("Web search results for: {}\n\n", response.query);
    for (idx, hit) in response.hits.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", idx + 1, hit.title));
        out.push_str(&format!("   URL: {}\n", hit.url));
        if !hit.snippet.is_empty() {
            out.push_str(&format!("   {}\n", hit.snippet));
        }
        out.push('\n');
    }
    out.push_str(
        "Use `web_fetch` to read the full content of any URL before quoting or summarizing it.",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_is_active_requires_enabled_and_key() {
        assert!(!LocalWebSearchConfig::default().is_active());
        assert!(!LocalWebSearchConfig {
            enabled: true,
            brave_api_key: None,
        }
        .is_active());
        assert!(!LocalWebSearchConfig {
            enabled: true,
            brave_api_key: Some("   ".to_string()),
        }
        .is_active());
        assert!(LocalWebSearchConfig {
            enabled: true,
            brave_api_key: Some("BSA123".to_string()),
        }
        .is_active());
        assert!(!LocalWebSearchConfig {
            enabled: false,
            brave_api_key: Some("BSA123".to_string()),
        }
        .is_active());
    }

    #[test]
    fn format_response_handles_empty_hits() {
        let response = WebSearchResponse {
            query: "nonexistent".to_string(),
            hits: vec![],
        };
        let rendered = format_response(&response);
        assert!(rendered.contains("No results"));
        assert!(rendered.contains("nonexistent"));
    }

    #[test]
    fn format_response_includes_title_url_snippet() {
        let response = WebSearchResponse {
            query: "rust".to_string(),
            hits: vec![WebSearchHit {
                title: "Rust Lang".to_string(),
                url: "https://rust-lang.org".to_string(),
                snippet: "A language empowering everyone".to_string(),
            }],
        };
        let rendered = format_response(&response);
        assert!(rendered.contains("1. Rust Lang"));
        assert!(rendered.contains("https://rust-lang.org"));
        assert!(rendered.contains("A language empowering everyone"));
        assert!(rendered.contains("web_fetch"));
    }
}
