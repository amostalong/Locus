//! Language Server Protocol bridge for the editor.
//!
//! Spawns external LSP servers (currently OmniSharp for C#) and pipes their
//! stdio JSON-RPC frames between the Rust process and the webview. Each
//! `start` call returns a session id that the frontend uses on subsequent
//! `send` and `stop` calls; outbound server messages arrive as Tauri events
//! on `lsp:<sessionId>:message`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::error::AppError;
use crate::process_util::{async_command, suppress_async_command_window};
use crate::MAIN_WINDOW_LABEL;

/// Pin a known-good OmniSharp release. Bump deliberately and re-test against
/// a Unity project.
const OMNISHARP_VERSION: &str = "v1.39.13";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LspKind {
    Omnisharp,
}

/// Outbound notification toward the webview, emitted on
/// `lsp:<session_id>:message`.
#[derive(Debug, Clone, Serialize)]
struct LspMessageEvent {
    session_id: String,
    /// The raw LSP JSON-RPC payload (no framing).
    message: serde_json::Value,
}

/// Lifecycle event for the session itself, emitted on `lsp:<session_id>:exit`.
#[derive(Debug, Clone, Serialize)]
struct LspExitEvent {
    session_id: String,
    code: Option<i32>,
    error: Option<String>,
}

struct LspSession {
    /// Sender into the stdin pump task. Drop to close the writer side.
    inbox: mpsc::UnboundedSender<serde_json::Value>,
    /// Background tasks (stdin/stdout/stderr/wait pumps). Aborted on stop.
    tasks: Vec<JoinHandle<()>>,
    /// Child handle, kept so `stop` can kill it explicitly if pumps stall.
    child: Arc<Mutex<Option<Child>>>,
}

#[derive(Default)]
pub struct LspManager {
    sessions: Mutex<HashMap<String, LspSession>>,
}

impl LspManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start(
        &self,
        app: &AppHandle,
        kind: LspKind,
        workspace_dir: String,
    ) -> Result<String, AppError> {
        match kind {
            LspKind::Omnisharp => self.start_omnisharp(app, workspace_dir).await,
        }
    }

    async fn start_omnisharp(
        &self,
        app: &AppHandle,
        workspace_dir: String,
    ) -> Result<String, AppError> {
        let trimmed = workspace_dir.trim();
        if trimmed.is_empty() {
            return Err(AppError::new(
                "lsp.workspace.empty",
                "workspaceDir is empty",
            ));
        }
        let workspace_path = PathBuf::from(trimmed);
        if !workspace_path.is_dir() {
            return Err(AppError::new(
                "lsp.workspace.not_found",
                format!("Workspace not found: {}", trimmed),
            ));
        }

        let binary = resolve_omnisharp_binary(app)?;
        let session_id = Uuid::new_v4().to_string();

        let mut cmd = async_command(binary.to_string_lossy().as_ref());
        cmd.arg("-lsp")
            .arg("-s")
            .arg(&workspace_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        suppress_async_command_window(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| {
            AppError::new(
                "lsp.spawn_failed",
                format!("Failed to spawn OmniSharp ({}): {}", binary.display(), e),
            )
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            AppError::new("lsp.stdin_unavailable", "OmniSharp stdin unavailable")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AppError::new("lsp.stdout_unavailable", "OmniSharp stdout unavailable")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AppError::new("lsp.stderr_unavailable", "OmniSharp stderr unavailable")
        })?;

        let (tx, rx) = mpsc::unbounded_channel::<serde_json::Value>();
        let child_handle: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));

        let stdin_task = tokio::spawn(stdin_pump(rx, stdin, session_id.clone()));
        let stdout_task = tokio::spawn(stdout_pump(stdout, app.clone(), session_id.clone()));
        let stderr_task = tokio::spawn(stderr_drain(stderr, session_id.clone()));
        let exit_task = tokio::spawn(exit_watcher(
            child_handle.clone(),
            app.clone(),
            session_id.clone(),
        ));

        let session = LspSession {
            inbox: tx,
            tasks: vec![stdin_task, stdout_task, stderr_task, exit_task],
            child: child_handle,
        };

        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), session);
        Ok(session_id)
    }

    pub async fn send(
        &self,
        session_id: &str,
        message: serde_json::Value,
    ) -> Result<(), AppError> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(session_id).ok_or_else(|| {
            AppError::new(
                "lsp.session_unknown",
                format!("LSP session not found: {}", session_id),
            )
        })?;
        session.inbox.send(message).map_err(|_| {
            AppError::new(
                "lsp.session_closed",
                format!("LSP session inbox closed: {}", session_id),
            )
        })
    }

    pub async fn stop(&self, session_id: &str) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.remove(session_id) else {
            return Ok(()); // already gone
        };
        // Drop the inbox first; stdin pump will exit cleanly when it sees the
        // channel close, which usually causes the child to exit too.
        drop(session.inbox);

        if let Some(mut child) = session.child.lock().await.take() {
            // Best-effort kill — child may already be exiting.
            let _ = child.kill().await;
        }
        for task in session.tasks {
            task.abort();
        }
        Ok(())
    }
}

async fn stdin_pump(
    mut rx: mpsc::UnboundedReceiver<serde_json::Value>,
    mut stdin: ChildStdin,
    session_id: String,
) {
    while let Some(message) = rx.recv().await {
        let body = match serde_json::to_vec(&message) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!(
                    "[lsp:{}] failed to encode outbound JSON: {}",
                    session_id, e
                );
                continue;
            }
        };
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        if let Err(e) = stdin.write_all(header.as_bytes()).await {
            eprintln!("[lsp:{}] stdin write failed (header): {}", session_id, e);
            return;
        }
        if let Err(e) = stdin.write_all(&body).await {
            eprintln!("[lsp:{}] stdin write failed (body): {}", session_id, e);
            return;
        }
        if let Err(e) = stdin.flush().await {
            eprintln!("[lsp:{}] stdin flush failed: {}", session_id, e);
            return;
        }
    }
}

async fn stdout_pump(
    stdout: tokio::process::ChildStdout,
    app: AppHandle,
    session_id: String,
) {
    let mut reader = BufReader::new(stdout);
    let event_name = format!("lsp:{}:message", session_id);
    let mut header_line = String::new();
    loop {
        let mut content_length: Option<usize> = None;
        loop {
            header_line.clear();
            match reader.read_line(&mut header_line).await {
                Ok(0) => return, // EOF
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[lsp:{}] stdout read header failed: {}", session_id, e);
                    return;
                }
            }
            let line = header_line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                break; // end of header block
            }
            if let Some(rest) = line
                .strip_prefix("Content-Length:")
                .or_else(|| line.strip_prefix("content-length:"))
            {
                if let Ok(n) = rest.trim().parse::<usize>() {
                    content_length = Some(n);
                }
            }
            // Other headers (e.g. Content-Type) are ignored.
        }

        let Some(len) = content_length else {
            eprintln!("[lsp:{}] stdout: missing Content-Length header", session_id);
            continue;
        };

        let mut body = vec![0u8; len];
        if let Err(e) = reader.read_exact(&mut body).await {
            eprintln!("[lsp:{}] stdout read body failed: {}", session_id, e);
            return;
        }

        let parsed: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[lsp:{}] stdout: invalid JSON body ({}): {}",
                    session_id,
                    e,
                    String::from_utf8_lossy(&body)
                );
                continue;
            }
        };

        let payload = LspMessageEvent {
            session_id: session_id.clone(),
            message: parsed,
        };
        if let Err(e) = app.emit_to(MAIN_WINDOW_LABEL, &event_name, payload) {
            eprintln!("[lsp:{}] failed to emit message event: {}", session_id, e);
        }
    }
}

async fn stderr_drain(stderr: tokio::process::ChildStderr, session_id: String) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => return,
            Ok(_) => {
                let trimmed = line.trim_end_matches(['\r', '\n']);
                if !trimmed.is_empty() {
                    eprintln!("[lsp:{} stderr] {}", session_id, trimmed);
                }
            }
            Err(_) => return,
        }
    }
}

async fn exit_watcher(
    child: Arc<Mutex<Option<Child>>>,
    app: AppHandle,
    session_id: String,
) {
    let result = {
        let mut guard = child.lock().await;
        let Some(mut handle) = guard.take() else {
            return;
        };
        // Release the lock while we wait so `stop` can still take the slot.
        drop(guard);
        handle.wait().await
    };
    let payload = match result {
        Ok(status) => LspExitEvent {
            session_id: session_id.clone(),
            code: status.code(),
            error: None,
        },
        Err(e) => LspExitEvent {
            session_id: session_id.clone(),
            code: None,
            error: Some(e.to_string()),
        },
    };
    let event_name = format!("lsp:{}:exit", session_id);
    let _ = app.emit_to(MAIN_WINDOW_LABEL, &event_name, payload);
}

/// Locate the OmniSharp executable. First-pass strategy:
/// 1. `LOCUS_OMNISHARP_PATH` env var, if set, points directly at the binary.
/// 2. Cached at `<app_data>/managed/omnisharp/<version>/OmniSharp[.exe]`.
/// 3. Otherwise return an error explaining where to put it.
///
/// Auto-download is intentionally NOT implemented in this commit — that lives
/// in a follow-up alongside progress UI on the frontend.
pub fn resolve_omnisharp_binary(app: &AppHandle) -> Result<PathBuf, AppError> {
    if let Ok(env_path) = std::env::var("LOCUS_OMNISHARP_PATH") {
        let trimmed = env_path.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if candidate.is_file() {
                return Ok(candidate);
            }
            return Err(AppError::new(
                "lsp.omnisharp.env_invalid",
                format!(
                    "LOCUS_OMNISHARP_PATH points to a missing file: {}",
                    candidate.display()
                ),
            ));
        }
    }

    let cache_dir = managed_omnisharp_dir(app)?;
    let exe = if cfg!(windows) {
        "OmniSharp.exe"
    } else {
        "OmniSharp"
    };
    let candidate = cache_dir.join(exe);
    if candidate.is_file() {
        return Ok(candidate);
    }

    Err(AppError::new(
        "lsp.omnisharp.missing",
        format!(
            "OmniSharp not found. Set LOCUS_OMNISHARP_PATH or extract the {} release into {}.",
            OMNISHARP_VERSION,
            cache_dir.display()
        ),
    ))
}

fn managed_omnisharp_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::new("lsp.app_data.unavailable", e.to_string()))?;
    Ok(base.join("managed").join("omnisharp").join(OMNISHARP_VERSION))
}
