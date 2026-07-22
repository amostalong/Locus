//! Local web search backend.
//!
//! Two providers are wired up:
//! - **Brave** — keyword SERP, returns title + URL + snippet. Pair with
//!   `web_fetch` for full page text.
//! - **Exa** — neural search, returns title + URL + pre-extracted page text
//!   (or a generated `summary`). Designed for LLM agents; usually a single
//!   `web_search` call is enough without a follow-up `web_fetch`.
//!
//! The struct / commands / UI treat them as one feature with an `engine`
//! switch so future providers (Google CSE, Tavily, …) can land behind the
//! same dispatch without touching the call sites.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const BRAVE_SEARCH_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_TIMEOUT_SECS: u64 = 20;
const BRAVE_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 LocusWebSearch/1.0";

const EXA_SEARCH_ENDPOINT: &str = "https://api.exa.ai/search";
const EXA_TIMEOUT_SECS: u64 = 30;
const EXA_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 LocusWebSearch/1.0";

/// Maximum number of results the tool will request from the upstream provider.
/// Brave's free tier is 20 results per query; Exa's is 10. We cap below both
/// to keep token cost on the LLM side predictable.
pub const MAX_RESULTS_CAP: u32 = 10;

/// Per-hit byte budget for Exa's extracted `text` field. Exa returns the
/// full page content; without a cap a single hit can be 50KB+ and blow up
/// the LLM context. 6 KiB keeps one search call under ~30K total chars
/// across the default 5 hits.
const EXA_TEXT_MAX_CHARS: usize = 6_000;

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

/// Provider selection for the local web-search tool. The order here is also
/// the order the UI presents them in — keep Brave first because existing
/// users have a key for it and the migration path preserves the choice.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SearchEngine {
    #[default]
    Brave,
    Exa,
}

impl SearchEngine {
    /// Stable id used by the UI / i18n. Matches the serde lowercase repr.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Brave => "brave",
            Self::Exa => "exa",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "brave" => Some(Self::Brave),
            "exa" => Some(Self::Exa),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalWebSearchConfig {
    pub enabled: bool,
    /// Which provider's API to call. Defaults to Brave so the user does not
    /// have to pick a provider before they can enable the feature.
    #[serde(default)]
    pub engine: SearchEngine,
    /// API key for the active engine. Persisted as a single field rather
    /// than per-engine so a key switch is a single secret rotate instead of
    /// remembering to wipe the old engine's field.
    ///
    /// `serde(alias = "braveApiKey")` lets configs written by the previous
    /// Brave-only commit (where the field was named `brave_api_key`) round
    /// trip through the new schema without losing the stored key.
    #[serde(default, alias = "braveApiKey", alias = "brave_api_key")]
    pub api_key: Option<String>,
}

impl Default for LocalWebSearchConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            engine: SearchEngine::default(),
            api_key: None,
        }
    }
}

impl LocalWebSearchConfig {
    /// Whether the tool should be advertised to the LLM and allowed to
    /// execute. The user must explicitly enable the feature AND provide a
    /// non-empty key for the active engine.
    pub fn is_active(&self) -> bool {
        self.enabled
            && self
                .api_key
                .as_ref()
                .map(|k| !k.trim().is_empty())
                .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchHit {
    pub title: String,
    pub url: String,
    /// Short summary / snippet. For Exa this is the `summary` field when
    /// present, otherwise the head of the extracted page text (already
    /// truncated to [`EXA_TEXT_MAX_CHARS`]). For Brave this is the search
    /// snippet verbatim.
    pub snippet: String,
    /// Full extracted page text (Exa only). Empty for Brave. Truncated to
    /// the per-hit byte cap. Use this directly when one search call needs
    /// to give the agent the answer instead of paying for a `web_fetch`
    /// round-trip on every result.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSearchResponse {
    pub query: String,
    pub engine: SearchEngine,
    pub hits: Vec<WebSearchHit>,
}

// ── Provider: Brave ─────────────────────────────────────────────────────────

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

async fn brave_search(
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

    let count = count.unwrap_or(10).clamp(1, MAX_RESULTS_CAP);
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
            if title.is_empty() || url.is_empty() {
                return None;
            }
            Some(WebSearchHit {
                title,
                url,
                snippet: entry.description.unwrap_or_default(),
                text: String::new(),
            })
        })
        .take(count as usize)
        .collect();

    Ok(WebSearchResponse {
        query: parsed.query.unwrap_or_else(|| trimmed_query.to_string()),
        engine: SearchEngine::Brave,
        hits,
    })
}

// ── Provider: Exa ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct ExaSearchRequest<'a> {
    query: &'a str,
    num_results: u32,
    /// `auto` lets Exa pick between neural and keyword per query. The other
    /// useful value is `neural` for semantic / exploratory questions.
    #[serde(rename = "type")]
    search_type: &'static str,
    /// Pull the extracted page text for every hit. Exa does the rendering
    /// server-side so we do not need a follow-up `web_fetch` per URL.
    #[serde(default)]
    contents: ExaContents,
}

#[derive(Debug, Default, Serialize)]
struct ExaContents {
    text: bool,
    /// `summary` is a short LLM-generated caption per hit; great for the
    /// tool output the LLM sees first.
    #[serde(default)]
    summary: bool,
}

#[derive(Debug, Deserialize)]
struct ExaApiResult {
    title: Option<String>,
    url: Option<String>,
    text: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExaApiResponse {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    results: Vec<ExaApiResult>,
}

async fn exa_search(
    api_key: &str,
    query: &str,
    count: Option<u32>,
) -> Result<WebSearchResponse, String> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Err("Error: web_search requires a non-empty `query`.".to_string());
    }
    let trimmed_key = api_key.trim();
    if trimmed_key.is_empty() {
        return Err("Error: web_search is missing an Exa API key.".to_string());
    }

    // Exa's free plan allows up to 10 results per request. We always request
    // 10 to maximize signal density; the LLM can decide which hits to
    // read in full.
    let count = count.unwrap_or(10).clamp(1, MAX_RESULTS_CAP);

    let client = crate::network::reqwest_client(
        crate::network::ReqwestClientOptions::new()
            .timeout(Duration::from_secs(EXA_TIMEOUT_SECS))
            .user_agent(EXA_USER_AGENT)
            .gzip(true)
            .deflate(true),
    )
    .map_err(|e| format!("Error creating HTTP client: {}", e))?;

    let body = ExaSearchRequest {
        query: trimmed_query,
        num_results: count,
        search_type: "auto",
        contents: ExaContents {
            text: true,
            summary: true,
        },
    };

    let response = client
        .post(EXA_SEARCH_ENDPOINT)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("x-api-key", trimmed_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Error sending search request: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let truncated_body: String = body.chars().take(400).collect();
        return Err(format!(
            "Exa Search API returned HTTP {} {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown"),
            truncated_body
        ));
    }

    let raw = response
        .text()
        .await
        .map_err(|e| format!("Error reading search response: {}", e))?;
    let parsed: ExaApiResponse = serde_json::from_str(&raw)
        .map_err(|e| format!("Error parsing Exa Search response: {}", e))?;

    let hits = parsed
        .results
        .into_iter()
        .filter_map(|entry| {
            let title = entry.title?;
            let url = entry.url?;
            if url.is_empty() {
                return None;
            }
            let text = entry
                .text
                .as_deref()
                .map(truncate_chars)
                .unwrap_or_default();
            // Prefer the LLM-generated `summary` as the snippet. If the
            // engine did not produce one, fall back to the head of the
            // extracted text so the tool output always has *something* to
            // show. The full text is still available separately.
            let snippet = entry
                .summary
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| first_n_chars(&text, 280));
            Some(WebSearchHit {
                title: if title.is_empty() { url.clone() } else { title },
                url,
                snippet,
                text,
            })
        })
        .take(count as usize)
        .collect();

    Ok(WebSearchResponse {
        query: parsed.query.unwrap_or_else(|| trimmed_query.to_string()),
        engine: SearchEngine::Exa,
        hits,
    })
}

// ── Public dispatch ────────────────────────────────────────────────────────

/// Run a search against the configured provider. The tool wrapper is
/// responsible for surfacing the error verbatim to the LLM.
pub async fn search(
    engine: SearchEngine,
    api_key: &str,
    query: &str,
    count: Option<u32>,
    safesearch: Option<&str>,
) -> Result<WebSearchResponse, String> {
    match engine {
        SearchEngine::Brave => brave_search(api_key, query, count, safesearch).await,
        SearchEngine::Exa => exa_search(api_key, query, count).await,
    }
}

/// Render search hits into the plain-text form we hand back to the LLM. We
/// use a numbered markdown-ish list because every downstream LLM is trained
/// on search-result formatting of this shape.
///
/// For Exa, when a hit carries extracted `text`, we include the head of it
/// inline so the agent can read the answer without paying for a follow-up
/// `web_fetch` round-trip. The full URL is still listed so `web_fetch`
/// remains available for deeper reads.
pub fn format_response(response: &WebSearchResponse) -> String {
    if response.hits.is_empty() {
        return format!(
            "No results for query: {}",
            response.query
        );
    }

    let include_text = matches!(response.engine, SearchEngine::Exa);

    let mut out = format!(
        "Web search results for: {} (via {})\n\n",
        response.query,
        engine_label(response.engine)
    );
    for (idx, hit) in response.hits.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", idx + 1, hit.title));
        out.push_str(&format!("   URL: {}\n", hit.url));
        if !hit.snippet.is_empty() {
            out.push_str(&format!("   {}\n", hit.snippet));
        }
        if include_text && !hit.text.is_empty() && hit.text != hit.snippet {
            out.push_str(&format!("\n   ---\n   {}\n", hit.text));
        }
        out.push('\n');
    }
    if include_text {
        out.push_str(
            "Each result already includes the extracted page text. Use `web_fetch` only when you need the full document beyond the excerpt shown above.",
        );
    } else {
        out.push_str(
            "Use `web_fetch` to read the full content of any URL before quoting or summarizing it.",
        );
    }
    out
}

fn engine_label(engine: SearchEngine) -> &'static str {
    match engine {
        SearchEngine::Brave => "Brave",
        SearchEngine::Exa => "Exa",
    }
}

fn truncate_chars(input: &str) -> String {
    if input.chars().count() <= EXA_TEXT_MAX_CHARS {
        return input.to_string();
    }
    let head: String = input.chars().take(EXA_TEXT_MAX_CHARS).collect();
    format!("{}\n\n[…truncated]", head)
}

fn first_n_chars(input: &str, max: usize) -> String {
    if input.chars().count() <= max {
        return input.to_string();
    }
    let head: String = input.chars().take(max).collect();
    format!("{}…", head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_is_active_requires_enabled_and_key() {
        assert!(!LocalWebSearchConfig::default().is_active());
        assert!(!LocalWebSearchConfig {
            enabled: true,
            engine: SearchEngine::Brave,
            api_key: None,
        }
        .is_active());
        assert!(!LocalWebSearchConfig {
            enabled: true,
            engine: SearchEngine::Brave,
            api_key: Some("   ".to_string()),
        }
        .is_active());
        assert!(LocalWebSearchConfig {
            enabled: true,
            engine: SearchEngine::Brave,
            api_key: Some("BSA123".to_string()),
        }
        .is_active());
        assert!(!LocalWebSearchConfig {
            enabled: false,
            engine: SearchEngine::Brave,
            api_key: Some("BSA123".to_string()),
        }
        .is_active());
    }

    #[test]
    fn config_migrates_legacy_brave_api_key_field() {
        // Existing installs persist under the old field name. Deserializing
        // them should keep the key instead of silently dropping it.
        let legacy = serde_json::json!({
            "enabled": true,
            "brave_api_key": "legacy-key-value",
        });
        let parsed: LocalWebSearchConfig = serde_json::from_value(legacy)
            .expect("legacy config should deserialize");
        assert_eq!(parsed.engine, SearchEngine::Brave);
        assert_eq!(parsed.api_key.as_deref(), Some("legacy-key-value"));
        assert!(parsed.is_active());
    }

    #[test]
    fn config_round_trip_with_engine_field() {
        let cfg = LocalWebSearchConfig {
            enabled: true,
            engine: SearchEngine::Exa,
            api_key: Some("exa-test".to_string()),
        };
        let serialized = serde_json::to_value(&cfg).expect("serialize");
        assert_eq!(serialized["engine"], "exa");
        assert_eq!(serialized["apiKey"], "exa-test");
        let parsed: LocalWebSearchConfig =
            serde_json::from_value(serialized).expect("deserialize");
        assert_eq!(parsed, cfg);
    }

    #[test]
    fn search_engine_parse_accepts_both_engines() {
        assert_eq!(SearchEngine::parse("brave"), Some(SearchEngine::Brave));
        assert_eq!(SearchEngine::parse("exa"), Some(SearchEngine::Exa));
        assert_eq!(SearchEngine::parse(" BRAVE "), Some(SearchEngine::Brave));
        assert_eq!(SearchEngine::parse(""), None);
        assert_eq!(SearchEngine::parse("google"), None);
    }

    #[test]
    fn format_response_brave_does_not_inline_text() {
        let response = WebSearchResponse {
            query: "rust".to_string(),
            engine: SearchEngine::Brave,
            hits: vec![WebSearchHit {
                title: "Rust Lang".to_string(),
                url: "https://rust-lang.org".to_string(),
                snippet: "A language".to_string(),
                text: String::new(),
            }],
        };
        let rendered = format_response(&response);
        assert!(rendered.contains("1. Rust Lang"));
        assert!(rendered.contains("https://rust-lang.org"));
        assert!(rendered.contains("A language"));
        assert!(rendered.contains("web_fetch"));
        assert!(rendered.contains("via Brave"));
        // Brave hits carry no extracted text; the output must not pretend
        // they do.
        assert!(!rendered.contains("---"));
    }

    #[test]
    fn format_response_exa_inlines_text() {
        let response = WebSearchResponse {
            query: "rust async".to_string(),
            engine: SearchEngine::Exa,
            hits: vec![WebSearchHit {
                title: "Async in Rust".to_string(),
                url: "https://example.com/async".to_string(),
                snippet: "Short caption".to_string(),
                text: "Long extracted body that the LLM can read directly.".to_string(),
            }],
        };
        let rendered = format_response(&response);
        assert!(rendered.contains("via Exa"));
        assert!(rendered.contains("Long extracted body"));
        assert!(rendered.contains("---"));
        assert!(rendered.contains("web_fetch"));
    }

    #[test]
    fn format_response_handles_empty_hits() {
        let response = WebSearchResponse {
            query: "nonexistent".to_string(),
            engine: SearchEngine::Brave,
            hits: vec![],
        };
        let rendered = format_response(&response);
        assert!(rendered.contains("No results"));
        assert!(rendered.contains("nonexistent"));
    }

    #[test]
    fn truncate_chars_caps_long_exa_text() {
        let long: String = "a".repeat(EXA_TEXT_MAX_CHARS + 100);
        let truncated = truncate_chars(&long);
        assert!(truncated.chars().count() <= EXA_TEXT_MAX_CHARS + 30);
        assert!(truncated.contains("truncated"));
    }
}
