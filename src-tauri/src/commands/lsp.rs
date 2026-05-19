use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::lsp::{LspKind, LspManager};

#[tauri::command]
pub async fn lsp_start(
    kind: LspKind,
    workspace_dir: String,
    app: AppHandle,
    manager: State<'_, Arc<LspManager>>,
) -> Result<String, AppError> {
    manager.start(&app, kind, workspace_dir).await
}

#[tauri::command]
pub async fn lsp_send(
    session_id: String,
    message: serde_json::Value,
    manager: State<'_, Arc<LspManager>>,
) -> Result<(), AppError> {
    manager.send(&session_id, message).await
}

#[tauri::command]
pub async fn lsp_stop(
    session_id: String,
    manager: State<'_, Arc<LspManager>>,
) -> Result<(), AppError> {
    manager.stop(&session_id).await
}
