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
