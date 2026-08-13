use tauri::State;

use crate::error::AppError;

/// Generic bridge from the Monaco frontend to the active Roslyn language
/// server. The frontend sends raw LSP `method` + `params` (the same shape
/// Monaco language clients normally use over a JSON-RPC socket); we route
/// it through `LspClient::request` so the editor gets hover / definition /
/// references / completion directly from the running server instead of the
/// dead OmniSharp stub.
///
/// Returns the raw JSON-RPC `result` value. Errors bubble up unchanged
/// (`workspace_disabled` / `server_not_ready` / `server_exited`).
#[tauri::command]
pub async fn csharp_lsp_bridge_request(
    method: String,
    params: serde_json::Value,
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<serde_json::Value, AppError> {
    if !crate::csharp_lsp::is_enabled() {
        return Err(AppError::new(
            "csharp_lsp.disabled",
            "C# code analysis is disabled",
        ));
    }
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Err(AppError::new(
            "csharp_lsp.no_workspace",
            "No workspace selected",
        ));
    }
    crate::csharp_lsp::bridge_lsp_request(&cwd, &method, params)
        .await
        .map_err(|error| AppError::new("csharp_lsp.request_failed", error))
}

/// Notify the Roslyn server that `path`'s on-disk content has changed
/// since the last sync. Drives `LspClient::sync_document` which decides
/// between a full didOpen (first time) and a didClose + didOpen
/// reopen (subsequent edits — Roslyn's incremental sync handler dies
/// on a rangeless full-text didChange, so we reopen). The same
/// `bridge_lsp_request` URI canonicalization we use for hover/definition
/// runs here too, so a Monaco-side `file:///c%3A/...` URI is
/// converted to the Roslyn-canonical `file:///C:/...` form before the
/// path is resolved. Called by the frontend EditorSync on every
/// debounced model change.
#[tauri::command]
pub async fn csharp_lsp_did_change(
    path: String,
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<(), AppError> {
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Err(AppError::new(
            "csharp_lsp.no_workspace",
            "No workspace selected",
        ));
    }
    let lsp = crate::csharp_lsp::bridge_ready_client(&cwd)
        .await
        .map_err(|error| AppError::new("csharp_lsp.sync_failed", error))?;
    let target = std::path::PathBuf::from(&path);
    lsp.sync_document(&target)
        .await
        .map(|_| ())
        .map_err(|error| AppError::new("csharp_lsp.sync_failed", error))
}

/// Notify the Roslyn server that `path` is no longer open in the
/// editor. We use the workspace-relative `sub_path` (forward-slash)
/// shape here because Monaco will pass a workspace-relative path on
/// dispose; the LspClient normalizes it to a `file://` URI for the
/// wire.
#[tauri::command]
pub async fn csharp_lsp_did_close(
    path: String,
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<(), AppError> {
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Err(AppError::new(
            "csharp_lsp.no_workspace",
            "No workspace selected",
        ));
    }
    let lsp = crate::csharp_lsp::bridge_ready_client(&cwd)
        .await
        .map_err(|error| AppError::new("csharp_lsp.close_failed", error))?;
    let uri = crate::csharp_lsp::client::path_to_uri(std::path::Path::new(&path))
        .map_err(|error| AppError::new("csharp_lsp.close_failed", error))?;
    lsp.notify(
        "textDocument/didClose",
        serde_json::json!({ "textDocument": { "uri": uri } }),
    )
    .await
    .map_err(|error| AppError::new("csharp_lsp.close_failed", error))
}

#[tauri::command]
pub async fn csharp_lsp_get_status() -> Result<crate::csharp_lsp::CsharpLspStatusPayload, AppError>
{
    Ok(crate::csharp_lsp::status().await)
}

#[tauri::command]
pub async fn csharp_lsp_set_enabled(
    value: bool,
    config: State<'_, std::sync::Arc<crate::config::AppConfig>>,
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<crate::csharp_lsp::CsharpLspStatusPayload, AppError> {
    config
        .set_csharp_lsp_enabled(value)
        .map_err(|error| AppError::new("csharp_lsp.persist_failed", error))?;

    let cwd = workspace.path.read().await.clone();
    let warm_target = (!cwd.trim().is_empty()).then_some(cwd);
    crate::csharp_lsp::set_enabled(value, warm_target).await;
    Ok(crate::csharp_lsp::status().await)
}

#[tauri::command]
pub async fn unity_sidecar_compiler_get_status(
) -> Result<crate::csharp_compile::CsharpCompileStatusPayload, AppError> {
    Ok(crate::csharp_compile::refresh_status().await)
}

#[tauri::command]
pub async fn unity_sidecar_compiler_set_enabled(
    value: bool,
    config: State<'_, std::sync::Arc<crate::config::AppConfig>>,
) -> Result<crate::csharp_compile::CsharpCompileStatusPayload, AppError> {
    config
        .set_unity_sidecar_compiler_enabled(value)
        .map_err(|error| AppError::new("csharp_compile.persist_failed", error))?;

    crate::csharp_compile::set_enabled(value).await;
    if value {
        crate::csharp_compile::warm_up_in_background();
    }
    Ok(crate::csharp_compile::status().await)
}

#[tauri::command]
pub async fn unity_non_public_access_set_enabled(
    value: bool,
    config: State<'_, std::sync::Arc<crate::config::AppConfig>>,
) -> Result<crate::csharp_compile::CsharpCompileStatusPayload, AppError> {
    config
        .set_unity_non_public_access_enabled(value)
        .map_err(|error| AppError::new("csharp_compile.persist_failed", error))?;

    crate::csharp_compile::set_non_public_access_enabled(value);
    Ok(crate::csharp_compile::status().await)
}

#[tauri::command]
pub async fn unity_in_process_compile_fallback_get_enabled(
    config: State<'_, std::sync::Arc<crate::config::AppConfig>>,
) -> Result<bool, AppError> {
    Ok(config.unity_in_process_compile_fallback_enabled())
}

/// Toggle the in-Unity Roslyn fallback used when the sidecar is on but a
/// compile is unavailable. Off = pure-sidecar (no in-process compile runs);
/// on = graceful fallback. Useful for A-B testing the sidecar in isolation.
#[tauri::command]
pub async fn unity_in_process_compile_fallback_set_enabled(
    value: bool,
    config: State<'_, std::sync::Arc<crate::config::AppConfig>>,
) -> Result<crate::csharp_compile::CsharpCompileStatusPayload, AppError> {
    config
        .set_unity_in_process_compile_fallback_enabled(value)
        .map_err(|error| AppError::new("csharp_compile.persist_failed", error))?;

    crate::csharp_compile::set_in_process_fallback(value);
    Ok(crate::csharp_compile::status().await)
}

#[tauri::command]
pub async fn unity_hot_reload_set_enabled(
    value: bool,
    config: State<'_, std::sync::Arc<crate::config::AppConfig>>,
) -> Result<crate::csharp_compile::CsharpCompileStatusPayload, AppError> {
    config
        .set_unity_hot_reload_enabled(value)
        .map_err(|error| AppError::new("unity_hotreload.persist_failed", error))?;

    crate::unity_hotreload::set_enabled(value);
    Ok(crate::csharp_compile::status().await)
}

/// Experimental (Phase B, default off): toggle whether the Unity plugin may
/// force-JIT a synthetic caller stub to evaluate a method's inline risk. Persists
/// to config and updates the live module flag delivered in each hot-patch payload.
#[tauri::command]
pub async fn unity_inline_force_evaluate_set_enabled(
    value: bool,
    config: State<'_, std::sync::Arc<crate::config::AppConfig>>,
) -> Result<crate::csharp_compile::CsharpCompileStatusPayload, AppError> {
    config
        .set_unity_inline_force_evaluate_enabled(value)
        .map_err(|error| AppError::new("unity_hotreload.persist_failed", error))?;

    crate::unity_hotreload::set_inline_force_evaluate_enabled(value);
    Ok(crate::csharp_compile::status().await)
}

#[tauri::command]
pub async fn unity_hot_reload_selftest_run(
    app: tauri::AppHandle,
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<(), AppError> {
    let cwd = workspace.path.read().await.clone();
    crate::unity_hotreload::selftest::run(app, cwd)
        .await
        .map_err(|error| AppError::new("unity_hotreload.selftest_failed", error))
}

/// C0 diagnostic: run (or return the cached) runtime access-capability probe
/// against the connected Unity editor and return the full matrix JSON
/// (`{cached, domainGeneration, caps, matrix}`). Needs the sidecar compiler
/// and a connected editor with a current plugin; independent of the
/// `unity_hot_reload` feature flag so it can be used to qualify an editor
/// before enabling hot reload.
#[tauri::command]
pub async fn unity_hot_reload_access_probe_run(
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<serde_json::Value, AppError> {
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Err(AppError::new(
            "unity_hotreload.no_workspace",
            "No workspace selected",
        ));
    }
    crate::unity_hotreload::coordinator::access_probe_run(&cwd)
        .await
        .map_err(|error| AppError::new("unity_hotreload.access_probe_failed", error))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotReloadPreflight {
    /// Whether a Unity editor answered the probe.
    pub connected: bool,
    /// "debug" | "release" when readable; `None` when the editor is
    /// unreachable or the value could not be parsed.
    pub code_optimization: Option<String>,
    /// Whether entering Play Mode reloads the domain (`Some(true)` = Unity's
    /// default reload, `Some(false)` = DisableDomainReload); `None` when the
    /// editor is unreachable or the plugin predates the toggle.
    pub domain_reload_on_play: Option<bool>,
}

/// Enable-time check the toggle UI runs before turning hot reload on: report
/// the connected editor's Code Optimization so the UI can warn (and offer to
/// auto-switch) when it is Release. Independent of the `unity_hot_reload`
/// feature flag. Never errors on a missing editor — the UI treats "can't tell"
/// as "go ahead", and the execution-time probe still gates real hot reloads.
#[tauri::command]
pub async fn unity_hot_reload_preflight(
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<HotReloadPreflight, AppError> {
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Ok(HotReloadPreflight {
            connected: false,
            code_optimization: None,
            domain_reload_on_play: None,
        });
    }
    let (connected, code_optimization, domain_reload_on_play) =
        crate::unity_hotreload::coordinator::detect_hot_reload_editor_settings(&cwd).await;
    Ok(HotReloadPreflight {
        connected,
        code_optimization,
        domain_reload_on_play,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeOptimizationResult {
    pub code_optimization: String,
}

/// Switch the connected editor's Code Optimization to Debug (the auto-fix the
/// user confirms in the enable-time prompt). Triggers a Unity script recompile.
#[tauri::command]
pub async fn unity_hot_reload_set_code_optimization_debug(
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<CodeOptimizationResult, AppError> {
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Err(AppError::new(
            "unity_hotreload.no_workspace",
            "No workspace selected",
        ));
    }
    let code_optimization = crate::unity_hotreload::coordinator::set_code_optimization_debug(&cwd)
        .await
        .map_err(|error| AppError::new("unity_hotreload.set_code_optimization_failed", error))?;
    Ok(CodeOptimizationResult { code_optimization })
}

/// Switch the connected editor's Code Optimization to an explicit level
/// ("debug" | "release"), driven by the hot-reload popover dropdown. Triggers a
/// Unity script recompile, exactly like flipping the Editor's status-bar icon.
#[tauri::command]
pub async fn unity_hot_reload_set_code_optimization(
    level: String,
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<CodeOptimizationResult, AppError> {
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Err(AppError::new(
            "unity_hotreload.no_workspace",
            "No workspace selected",
        ));
    }
    let code_optimization =
        crate::unity_hotreload::coordinator::set_code_optimization(&cwd, &level)
            .await
            .map_err(|error| {
                AppError::new("unity_hotreload.set_code_optimization_failed", error)
            })?;
    Ok(CodeOptimizationResult { code_optimization })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayModeReloadResult {
    pub domain_reload_on_play: bool,
}

/// Set whether entering Play Mode reloads the domain, driven by the manual
/// hot-reload popover toggle (EditorSettings.enterPlayModeOptions /
/// DisableDomainReload). Unlike the Code Optimization switch this does NOT
/// trigger a Unity recompile. Returns the resulting effective value.
#[tauri::command]
pub async fn unity_hot_reload_set_play_mode_reload(
    domain_reload: bool,
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<PlayModeReloadResult, AppError> {
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Err(AppError::new(
            "unity_hotreload.no_workspace",
            "No workspace selected",
        ));
    }
    let domain_reload_on_play =
        crate::unity_hotreload::coordinator::set_play_mode_reload(&cwd, domain_reload)
            .await
            .map_err(|error| AppError::new("unity_hotreload.set_play_mode_reload_failed", error))?;
    Ok(PlayModeReloadResult {
        domain_reload_on_play,
    })
}

#[tauri::command]
pub async fn code_analysis_tools_get_config(
    config: State<'_, std::sync::Arc<crate::config::AppConfig>>,
) -> Result<crate::config::CodeAnalysisToolsConfig, AppError> {
    Ok(config.code_analysis_tools())
}

#[tauri::command]
pub async fn code_analysis_tools_set_config(
    value: crate::config::CodeAnalysisToolsConfig,
    config: State<'_, std::sync::Arc<crate::config::AppConfig>>,
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<crate::config::CodeAnalysisToolsConfig, AppError> {
    let previous = config.code_analysis_tools();
    config
        .set_code_analysis_tools(value)
        .map_err(|error| AppError::new("code_analysis.persist_failed", error))?;
    crate::code_tools::set(value);

    // The analyzer set is wired into the language server workspace at startup
    // (Directory.Build.props), so flipping it only takes effect after a
    // server restart. Do that in the background when one is running.
    if previous.unity_analyzers != value.unity_analyzers && crate::csharp_lsp::is_enabled() {
        let cwd = workspace.path.read().await.clone();
        if !cwd.trim().is_empty() {
            tokio::spawn(async move {
                let _ = crate::csharp_lsp::restart(&cwd).await;
            });
        }
    }
    Ok(config.code_analysis_tools())
}

#[tauri::command]
pub async fn csharp_lsp_restart(
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<crate::csharp_lsp::CsharpLspStatusPayload, AppError> {
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Err(AppError::new(
            "csharp_lsp.no_workspace",
            "No workspace selected",
        ));
    }
    crate::csharp_lsp::restart(&cwd)
        .await
        .map_err(|error| AppError::new("csharp_lsp.restart_failed", error))?;
    Ok(crate::csharp_lsp::status().await)
}

/// Collects preprocessor symbols for the current file's owning csproj, so
/// Monaco's `#if` dimming reflects the defines that *this file* actually
/// compiles under — not the union of every csproj in the workspace.
///
/// When `file_rel_path` is `Some`:
///   Find the csproj whose directory is the deepest ancestor of the file.
///   Per-asmdef csproj convention (Unity + Rider integration) places each
///   csproj next to its `.asmdef` and the csproj's directory covers the
///   asmdef's subtree. Picking the deepest ancestor matches that mapping
///   for >95% of Unity projects.
///
/// When `file_rel_path` is `None` (no active file yet) or no csproj claims
/// the file (e.g. a file outside any asmdef subtree):
///   Fall back to the union of all csprojs in the workspace — same behaviour
///   as before this change, so existing callers that pass no arg keep working.
///
/// The editor uses this to dim inactive `#if` branches with Monaco decorations.
#[tauri::command]
pub async fn get_preprocessor_symbols(
    file_rel_path: Option<String>,
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<Vec<String>, AppError> {
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Err(AppError::new(
            "csharp_lsp.no_workspace",
            "No workspace selected",
        ));
    }

    if let Some(rel) = file_rel_path.as_deref() {
        if !rel.trim().is_empty() {
            if let Some(symbols) = collect_symbols_for_file(&cwd, rel) {
                return Ok(symbols);
            }
        }
    }

    collect_symbols_union(&cwd)
}

/// Walk every `.csproj` under `cwd` and return the union of their
/// `<DefineConstants>`. Used as a fallback when we can't attribute a file
/// to a single csproj.
fn collect_symbols_union(cwd: &str) -> Result<Vec<String>, AppError> {
    let mut symbols = std::collections::HashSet::new();
    for entry in csproj_walk(cwd) {
        if entry.file_type().is_file()
            && entry.path().extension().map_or(false, |e| e == "csproj")
        {
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                if let Some(constants) = parse_csproj_define_constants(&content) {
                    for sym in constants {
                        symbols.insert(sym);
                    }
                }
            }
        }
    }

    let mut result: Vec<String> = symbols.into_iter().collect();
    result.sort();
    Ok(result)
}

/// Find the csproj that "owns" `rel_path` (a workspace-relative, forward-slash
/// path) and return its `<DefineConstants>`. "Owns" = the csproj whose
/// directory is the deepest ancestor of the file's absolute path. Returns
/// `None` if no csproj contains the file (caller should fall back to union).
fn collect_symbols_for_file(cwd: &str, rel_path: &str) -> Option<Vec<String>> {
    // rel_path is workspace-relative; normalise separators then resolve.
    let normalised = rel_path.replace('\\', "/");
    let trimmed = normalised.trim_start_matches('/');
    let file_abs = std::path::Path::new(cwd).join(trimmed);

    // Deepest matching csproj dir wins.
    let mut best_depth: Option<usize> = None;
    let mut best_symbols: Option<Vec<String>> = None;
    for entry in csproj_walk(cwd) {
        if !entry.file_type().is_file()
            || !entry.path().extension().map_or(false, |e| e == "csproj")
        {
            continue;
        }
        let csproj_dir = match entry.path().parent() {
            Some(p) => p,
            None => continue,
        };
        if !file_abs.starts_with(csproj_dir) {
            continue;
        }
        let depth = csproj_dir.components().count();
        if best_depth.map_or(true, |d| depth > d) {
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                if let Some(constants) = parse_csproj_define_constants(&content) {
                    best_depth = Some(depth);
                    best_symbols = Some(constants);
                }
            }
        }
    }

    best_symbols.map(|v| {
        let mut sorted = v;
        sorted.sort();
        sorted
    })
}

fn csproj_walk(cwd: &str) -> impl Iterator<Item = walkdir::DirEntry> {
    walkdir::WalkDir::new(cwd)
        .follow_links(true)
        .max_depth(8)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
                && name != "Library"
                && name != "Temp"
                && name != "obj"
                && name != "bin"
        })
        .filter_map(|e| e.ok())
}

/// Extracts `<DefineConstants>...</DefineConstants>` from a .csproj XML body.
fn parse_csproj_define_constants(csproj_body: &str) -> Option<Vec<String>> {
    let start_tag = "<DefineConstants>";
    let end_tag = "</DefineConstants>";
    let start = csproj_body.find(start_tag)? + start_tag.len();
    let end = csproj_body.find(end_tag)?;
    let raw = csproj_body[start..end].trim();
    if raw.is_empty() {
        return Some(Vec::new());
    }
    Some(
        raw.split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
    )
}

// ────────────────────────────────────────────────────────────────────────────
// Preprocessor-symbol probe via Roslyn completion (preferred path)
// ────────────────────────────────────────────────────────────────────────────

use std::sync::OnceLock;

/// Find the (0-based line, 0-based char) position to send a
/// `textDocument/completion` request at, such that Roslyn interprets
/// the context as "completing a preprocessor directive name" (e.g.
/// `#if X`, `#elif X`, `#define X`).
///
/// Strategy: walk the file from the end backwards and pick the *last*
/// line that begins with one of `#if`, `#elif`, or `#define` followed
/// by whitespace. The cursor lands right after that whitespace — the
/// text before the cursor is exactly `#if ` (or similar) with no
/// identifier the user has started typing yet, so Roslyn returns the
/// full preprocessor table (no prefix-filter). Picking the last match
/// means any source-level `#define` directives earlier in the file
/// have already been accumulated into the table, so the response
/// covers them too.
///
/// Returns `None` if the file has no preprocessor directives that
/// take a name — in that case there's no `#if X` in the file to dim,
/// so the caller should just return an empty symbol set.
fn find_completion_position(content: &str) -> Option<(u32, u32)> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        // Match a line that starts (allowing leading whitespace) with
        // `#if`, `#elif`, or `#define` followed by at least one
        // whitespace. The end of the match is the position we want.
        //
        // The `\t` in `[ \t]` is the regex tab escape, not a raw-string
        // escape — Rust's `r"..."` leaves the `\t` two characters
        // (`\` and `t`) for the regex engine to interpret, and the
        // regex engine reads `\t` as tab. So this class matches space
        // or tab. (An earlier version had `[ \\t]` which the regex
        // engine read as backslash-or-t, not tab — that was a typo.
        // Don't reintroduce it.)
        regex::Regex::new(r"^[ \t]*#[ \t]*(?:if|elif|define)[ \t]+").unwrap()
    });
    // Walk the file from the end so the picked directive sees the
    // largest possible set of source-level `#define`s already in
    // scope. `Lines` isn't `DoubleEndedIterator`, so collect first.
    let lines: Vec<&str> = content.lines().collect();
    for (line_idx, line) in lines.iter().enumerate().rev() {
        if let Some(m) = re.find(line) {
            // m.end() is a *byte* offset within `line`. The LSP
            // `character` field is a UTF-16 code-unit offset. For the
            // ASCII C# code we deal with (preprocessor identifiers are
            // always ASCII), byte == UTF-16 code unit, so the cast is
            // safe. We still go through `chars().count()` so a future
            // change to non-ASCII preprocessor tokens doesn't silently
            // misalign.
            let col = line[..m.end()].chars().count() as u32;
            return Some((line_idx as u32, col));
        }
    }
    None
}

/// Per-file cache for the completion-based probe, keyed by absolute
/// file path. We hash the file content (blake3 — already a dependency
/// via `editorSync`) and reuse the cached `Vec<String>` if the hash
/// matches. A small TTL on top keeps the cache fresh in case the
/// underlying project's preprocessor table changes (csproj / Unity
/// build-target switch) without this file's content changing.
#[derive(Clone)]
struct CompletionCacheEntry {
    content_hash: [u8; 32],
    fetched_at: std::time::Instant,
    symbols: Vec<String>,
}
static COMPLETION_CACHE: OnceLock<std::sync::Mutex<
    std::collections::HashMap<std::path::PathBuf, CompletionCacheEntry>,
>> = OnceLock::new();
const COMPLETION_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// Asks the running Roslyn server for the file's preprocessor symbol
/// table by sending a `textDocument/completion` request at a
/// `#if` / `#elif` / `#define` line in the file. The completion
/// provider's preprocessor context returns the full symbol table
/// (csproj `<DefineConstants>` after MSBuild `[Condition]`
/// evaluation, plus every source-level `#define` seen so far in the
/// file).
///
/// **Why this works in a single roundtrip**: the LSP completion
/// provider at a position immediately after `#if ` (or similar)
/// returns the entire preprocessor table, not a prefix-filtered
/// subset, because there's no identifier text before the cursor to
/// filter on. We pick the *last* directive line in the file so any
/// source-level `#define` earlier in the file has already been
/// accumulated into the per-file preprocessor scope.
///
/// **Why not `textDocument/semanticTokens/full`**: Roslyn's
/// classification of an identifier inside `#if X` is the same token
/// type as a regular identifier in code (`UNITY_EDITOR` and `_rectTf`
/// both come back as the same `identifier` semantic-token type — only
/// the preprocessor *keywords* like `if`/`else`/`endif` get a
/// dedicated type). So semantic tokens can't distinguish
/// preprocessor-symbol identifiers from regular ones. Completion at
/// the directive context, on the other hand, is exactly the
/// "give-me-the-preprocessor-table" hook.
///
/// Cached in-process by file path + content hash + 30s TTL. The
/// caller should treat a bridge error as "fall back to the csproj
/// path" rather than a hard failure — when the server is still
/// warming up the bridge rejects, and we'd rather have a degraded
/// but not-broken dimming experience than a hard error.
#[tauri::command]
pub async fn get_preprocessor_symbols_via_completion(
    file_rel_path: Option<String>,
    workspace: State<'_, std::sync::Arc<crate::workspace::Workspace>>,
) -> Result<Vec<String>, AppError> {
    let cwd = workspace.path.read().await.clone();
    if cwd.trim().is_empty() {
        return Err(AppError::new(
            "csharp_lsp.no_workspace",
            "No workspace selected",
        ));
    }
    let rel = match file_rel_path.as_deref() {
        Some(s) if !s.trim().is_empty() => s,
        _ => {
            tracing::warn!(
                log_module = "csharp_lsp.preprocessor",
                "[macroProbe] no file_rel_path supplied; completion probe needs a target file, returning empty"
            );
            return Ok(Vec::new());
        }
    };
    let normalised = rel.replace('\\', "/");
    let trimmed = normalised.trim_start_matches('/');
    let file_abs = std::path::Path::new(&cwd).join(trimmed);

    // Read file content. Without it we can't pick a completion
    // position. If the file is unreadable, fall through to the
    // caller's csproj fallback by returning an empty set.
    let content = match std::fs::read_to_string(&file_abs) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                log_module = "csharp_lsp.preprocessor",
                "[macroProbe] failed to read {}: {}; returning empty",
                file_abs.display(),
                e
            );
            return Ok(Vec::new());
        }
    };

    // blake3 content hash for cache key.
    let content_hash = *blake3::hash(content.as_bytes()).as_bytes();

    // Cache hit?
    if let Some(cache) = COMPLETION_CACHE.get() {
        if let Ok(guard) = cache.lock() {
            if let Some(entry) = guard.get(&file_abs) {
                if entry.content_hash == content_hash
                    && entry.fetched_at.elapsed() < COMPLETION_CACHE_TTL
                {
                    tracing::debug!(
                        log_module = "csharp_lsp.preprocessor",
                        "[macroProbe] cache hit for {} (age={}ms, {} symbols)",
                        trimmed,
                        entry.fetched_at.elapsed().as_millis(),
                        entry.symbols.len()
                    );
                    return Ok(entry.symbols.clone());
                }
            }
        }
    }

    // No usable preprocessor position in the file → the file has no
    // `#if`/`#elif`/`#define` directives, so there are no
    // preprocessor conditions in it to dim. Return an empty set
    // rather than falling back to the csproj path (the csproj path
    // would give us *all* defines including ones from other asmdefs
    // — worse than empty for a file with no `#if` at all).
    let Some((line, character)) = find_completion_position(&content) else {
        tracing::debug!(
            log_module = "csharp_lsp.preprocessor",
            "[macroProbe] no #if/#elif/#define line in {}; returning empty (file has no preprocessor conditions to dim)",
            trimmed
        );
        let empty: Vec<String> = Vec::new();
        // Cache the empty result so we don't re-scan on every refresh.
        let cache = COMPLETION_CACHE.get_or_init(|| {
            std::sync::Mutex::new(std::collections::HashMap::new())
        });
        if let Ok(mut guard) = cache.lock() {
            guard.insert(
                file_abs.clone(),
                CompletionCacheEntry {
                    content_hash,
                    fetched_at: std::time::Instant::now(),
                    symbols: empty.clone(),
                },
            );
        }
        return Ok(empty);
    };

    let uri = crate::csharp_lsp::client::path_to_uri(&file_abs).map_err(|e| {
        AppError::new(
            "csharp_lsp.uri_encode_failed",
            format!("path_to_uri failed for {}: {}", file_abs.display(), e),
        )
    })?;

    tracing::debug!(
        log_module = "csharp_lsp.preprocessor",
        "[macroProbe] completion @ line {} col {} (uri={})",
        line,
        character,
        uri
    );

    // bridge_lsp_request sync_documents + canonicalises the URI for us.
    let params = serde_json::json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character },
        "context": {
            // TriggerKind.Invoked = 1 — explicit completion request,
            // not a re-trigger. We want the full table, not whatever
            // the editor had cached for a previous trigger character.
            "triggerKind": 1
        }
    });
    let response = crate::csharp_lsp::bridge_lsp_request(
        &cwd,
        "textDocument/completion",
        params,
    )
    .await
    .map_err(|e| {
        tracing::warn!(
            log_module = "csharp_lsp.preprocessor",
            "[macroProbe] completion failed for {}: {}",
            trimmed,
            e
        );
        AppError::new("csharp_lsp.completion_failed", e)
    })?;

    // Response shape: `CompletionItem[]` OR `CompletionList { items, isIncomplete }` OR `null`.
    let items: Vec<serde_json::Value> = match &response {
        serde_json::Value::Array(arr) => arr.clone(),
        serde_json::Value::Object(obj) => obj
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        serde_json::Value::Null => Vec::new(),
        other => {
            tracing::warn!(
                log_module = "csharp_lsp.preprocessor",
                "[macroProbe] unexpected completion response shape: {}",
                other
            );
            Vec::new()
        }
    };

    let raw_count = items.len();
    let mut symbols = std::collections::HashSet::new();
    for item in &items {
        // Roslyn's preprocessor completion items have the symbol name
        // in the `label` field. Some builds also populate
        // `insertText` with the same string; we prefer `label` since
        // that's what the LSP spec mandates.
        let label = item
            .get("label")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("insertText").and_then(|v| v.as_str()));
        if let Some(label) = label {
            symbols.insert(label.to_string());
        }
    }

    // Some Roslyn builds also return non-symbol items at this
    // position (rare, but possible if the server re-falls-back to
    // general completion). Drop anything that isn't a valid C#
    // identifier to keep the set matching the dimming check's
    // expectations.
    let before = symbols.len();
    symbols.retain(|s| {
        let mut chars = s.chars();
        match chars.next() {
            Some(c) if c == '_' || c.is_alphabetic() => {}
            _ => return false,
        }
        chars.all(|c| c == '_' || c.is_alphanumeric())
    });
    if symbols.len() != before {
        tracing::debug!(
            log_module = "csharp_lsp.preprocessor",
            "[macroProbe] filtered {} non-identifier items (likely completion noise)",
            before - symbols.len()
        );
    }

    let mut result: Vec<String> = symbols.into_iter().collect();
    result.sort();
    tracing::info!(
        log_module = "csharp_lsp.preprocessor",
        "[macroProbe] completion returned {} item(s), {} valid symbol(s) for {}: {:?}",
        raw_count,
        result.len(),
        trimmed,
        result
    );

    // Cache.
    let cache = COMPLETION_CACHE.get_or_init(|| {
        std::sync::Mutex::new(std::collections::HashMap::new())
    });
    if let Ok(mut guard) = cache.lock() {
        // Only cache if non-empty, to give Roslyn another chance
        // to populate the table if the server is still warming
        // up — a stale empty result would silently break dimming.
        if !result.is_empty() {
            guard.insert(
                file_abs.clone(),
                CompletionCacheEntry {
                    content_hash,
                    fetched_at: std::time::Instant::now(),
                    symbols: result.clone(),
                },
            );
        }
    }

    Ok(result)
}
