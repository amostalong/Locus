//! Language Server Protocol bridge for the editor.
//!
//! Spawns external LSP servers (currently OmniSharp for C#) and pipes their
//! stdio JSON-RPC frames between the Rust process and the webview. Each
//! `start` call returns a session id that the frontend uses on subsequent
//! `send` and `stop` calls; outbound server messages arrive as Tauri events
//! on `lsp:<sessionId>:message`.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::OnceLock;

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
const OMNISHARP_VERSION: &str = "v1.39.15";

/// When the `LOCUS_LSP_TRACE` env var is set to a path, every inbound and
/// outbound JSON-RPC frame is appended to that file as a single line:
///   `RX <session_id> <json>`  /  `TX <session_id> <json>`
/// Used by `scripts\start-dev-with-trace.bat` to capture LSP traffic from
/// the running app for offline analysis. Disabled if unset.
fn trace_path() -> Option<&'static PathBuf> {
    static SLOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    SLOT.get_or_init(|| std::env::var_os("LOCUS_LSP_TRACE").map(PathBuf::from))
        .as_ref()
}

fn trace_message(direction: &str, session_id: &str, value: &serde_json::Value) {
    let Some(path) = trace_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let line = format!(
        "{} {} {}\n",
        direction,
        session_id,
        serde_json::to_string(value).unwrap_or_default()
    );
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(mut f) => {
            if let Err(e) = f.write_all(line.as_bytes()) {
                eprintln!("[lsp:trace] write failed: {}", e);
            }
            if let Err(e) = f.flush() {
                eprintln!("[lsp:trace] flush failed: {}", e);
            }
        }
        Err(e) => {
            eprintln!("[lsp:trace] open failed for {}: {}", path.display(), e);
        }
    }
}

fn trace_session_start(session_id: &str, kind: &str, workspace_dir: &str) {
    let Some(path) = trace_path() else { return };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let header = serde_json::json!({
        "ts_ms": now,
        "kind": kind,
        "workspace_dir": workspace_dir,
    });
    trace_message("== SESSION START ==", session_id, &header);
    eprintln!(
        "[lsp:trace] session {} started; tracing to {}",
        session_id,
        path.display()
    );
}

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
        // Unity / installed Visual Studio Build Tools / standalone .NET SDKs
        // commonly export MSBUILD_EXE_PATH, MSBuildExtensionsPath, etc. into
        // the user environment. Old VS BuildTools 2017 / Mono MSBuild on the
        // search path will be picked up by OmniSharp's MSBuildLocator
        // ahead of a freshly-installed .NET SDK, dying with
        // TypeLoadException ("DisposeAsync method has no implementation")
        // because the loaded Microsoft.Build.dll predates Roslyn's MSBuild
        // API surface. Strip everything MSBuild-flavoured and then point
        // MSBUILD_EXE_PATH at the newest installed .NET SDK MSBuild.dll
        // we can find — that's the one OmniSharp's Roslyn was built
        // against.
        cmd.env_remove("MSBUILD_EXE_PATH")
            .env_remove("MSBuildExtensionsPath")
            .env_remove("MSBuildExtensionsPath32")
            .env_remove("MSBuildExtensionsPath64")
            .env_remove("MSBuildSDKsPath")
            .env_remove("MSBuildToolsPath")
            .env_remove("MSBuildToolsPath32")
            .env_remove("MSBuildToolsPath64")
            .env_remove("VSINSTALLDIR")
            .env_remove("VCINSTALLDIR")
            .env_remove("VisualStudioVersion");
        // The bundled OmniSharp is the `-net6.0` apphost. Its runtimeconfig
        // requests .NET 6, but most dev machines only ship .NET 8/10 SDKs.
        // Tell the host to roll forward across major versions so it picks up
        // whatever's installed instead of failing with "You must install or
        // update .NET to run this application."
        cmd.env("DOTNET_ROLL_FORWARD", "Major");
        if let Some(msbuild) = locate_dotnet_sdk_msbuild() {
            eprintln!("[lsp] forcing OmniSharp MSBuild path: {}", msbuild.display());
            cmd.env("MSBUILD_EXE_PATH", &msbuild);
        }
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

        trace_session_start(&session_id, "omnisharp", trimmed);

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

/// Normalize a `file://` URI for OmniSharp: undo `%3A` -> `:` and uppercase the
/// drive letter. monaco-vscode-api emits `file:///c%3A/Users/...`, OmniSharp
/// 1.39.x net6.0 chokes on that variant during initialize and never sends
/// the response — projects still load via a different task, but the LSP
/// handshake hangs forever.
fn normalize_omnisharp_uri(uri: &str) -> String {
    if !uri.starts_with("file://") {
        return uri.to_string();
    }
    // URL-decode common drive-letter encodings.
    let decoded = uri.replace("%3A", ":").replace("%3a", ":");
    // Uppercase the drive letter that immediately follows `file:///`.
    if let Some(rest) = decoded.strip_prefix("file:///") {
        let mut chars = rest.chars();
        match (chars.next(), chars.next()) {
            (Some(c), Some(':')) if c.is_ascii_alphabetic() => {
                let upper = c.to_ascii_uppercase();
                let tail: String = chars.collect();
                return format!("file:///{}:{}", upper, tail);
            }
            _ => {}
        }
    }
    decoded
}

/// Mutate an outbound `initialize` request so OmniSharp can complete the
/// handshake. Returns the mutated value (mutates in place via `&mut`).
///
/// Workarounds applied:
///   1. Normalize `rootUri` and every `workspaceFolders[].uri` (drive-letter
///      casing + percent-decoding).
///   2. Strip `workspace.configuration` so OmniSharp doesn't try a
///      synchronous server-to-client `workspace/configuration` request from
///      inside its initialize handler.
fn rewrite_initialize_for_omnisharp(message: &mut serde_json::Value) {
    let Some(method) = message.get("method").and_then(|m| m.as_str()) else {
        return;
    };
    if method != "initialize" {
        return;
    }
    let Some(params) = message.get_mut("params").and_then(|p| p.as_object_mut()) else {
        return;
    };

    if let Some(uri) = params.get_mut("rootUri").and_then(|v| v.as_str().map(str::to_owned)) {
        let normalized = normalize_omnisharp_uri(&uri);
        params.insert("rootUri".to_string(), serde_json::Value::String(normalized));
    }
    if let Some(folders) = params.get_mut("workspaceFolders").and_then(|v| v.as_array_mut()) {
        for folder in folders {
            if let Some(obj) = folder.as_object_mut() {
                if let Some(uri) = obj.get("uri").and_then(|v| v.as_str().map(str::to_owned)) {
                    let normalized = normalize_omnisharp_uri(&uri);
                    obj.insert("uri".to_string(), serde_json::Value::String(normalized));
                }
            }
        }
    }
    if let Some(caps) = params
        .get_mut("capabilities")
        .and_then(|c| c.get_mut("workspace"))
        .and_then(|w| w.as_object_mut())
    {
        caps.remove("configuration");
    }
}

async fn stdin_pump(
    mut rx: mpsc::UnboundedReceiver<serde_json::Value>,
    mut stdin: ChildStdin,
    session_id: String,
) {
    while let Some(mut message) = rx.recv().await {
        rewrite_initialize_for_omnisharp(&mut message);
        trace_message("TX", &session_id, &message);
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

        trace_message("RX", &session_id, &parsed);

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

/// Locate the OmniSharp executable. Resolution strategy:
/// 1. `LOCUS_OMNISHARP_PATH` env var, if set, points directly at the binary.
/// 2. Cached at `<app_data>/managed/omnisharp/<version>/OmniSharp[.exe]`
///    (release-bundle / installed-app location).
/// 3. Repo-local dev cache populated by `bun run omnisharp:prepare` at
///    `<CARGO_MANIFEST_DIR>/gen/managed-omnisharp/<arch>/OmniSharp[.exe]`.
/// 4. Otherwise return an error explaining where to put it.
///
/// Auto-download is intentionally NOT implemented here — that lives in a
/// follow-up alongside progress UI on the frontend.
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

    let exe = if cfg!(windows) {
        "OmniSharp.exe"
    } else {
        "OmniSharp"
    };

    let cache_dir = managed_omnisharp_dir(app)?;
    let app_data_candidate = cache_dir.join(exe);
    if app_data_candidate.is_file() {
        return Ok(app_data_candidate);
    }

    let dev_candidate = repo_dev_omnisharp_path(exe);
    if let Some(path) = dev_candidate.as_ref() {
        if path.is_file() {
            return Ok(path.clone());
        }
    }

    Err(AppError::new(
        "lsp.omnisharp.missing",
        format!(
            "OmniSharp not found. Run `bun run omnisharp:prepare`, set LOCUS_OMNISHARP_PATH, or extract the {} release into {}.",
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

/// Path to the OmniSharp binary inside the repo's dev cache (where
/// `scripts/prepare-managed-omnisharp.mjs` extracts it). This matches the
/// per-platform `dirKey` from that script.
fn repo_dev_omnisharp_path(exe: &str) -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let arch = if cfg!(target_os = "windows") {
        if cfg!(target_arch = "x86_64") {
            "windows-x64"
        } else if cfg!(target_arch = "aarch64") {
            "windows-arm64"
        } else if cfg!(target_arch = "x86") {
            "windows-x86"
        } else {
            return None;
        }
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "x86_64") {
            "macos-x64"
        } else if cfg!(target_arch = "aarch64") {
            "macos-arm64"
        } else {
            return None;
        }
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "x86_64") {
            "linux-x64"
        } else if cfg!(target_arch = "aarch64") {
            "linux-arm64"
        } else {
            return None;
        }
    } else {
        return None;
    };
    Some(
        manifest_dir
            .join("gen")
            .join("managed-omnisharp")
            .join(arch)
            .join(exe),
    )
}

/// Locate the newest installed .NET SDK MSBuild.dll on the host so we can
/// hand it to OmniSharp via `MSBUILD_EXE_PATH`. Returns `None` if no SDK is
/// installed — caller will let MSBuildLocator do its default discovery.
fn locate_dotnet_sdk_msbuild() -> Option<PathBuf> {
    let candidate_roots: Vec<PathBuf> = if cfg!(windows) {
        let mut roots = vec![];
        if let Ok(pf) = std::env::var("ProgramFiles") {
            roots.push(PathBuf::from(pf).join("dotnet").join("sdk"));
        }
        if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
            roots.push(PathBuf::from(pf86).join("dotnet").join("sdk"));
        }
        roots
    } else if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/usr/local/share/dotnet/sdk"),
            PathBuf::from("/opt/homebrew/share/dotnet/sdk"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/share/dotnet/sdk"),
            PathBuf::from("/usr/lib/dotnet/sdk"),
        ]
    };

    // OmniSharp 1.39.x was built against .NET 8 SDK. Newer SDKs (.NET 10+)
    // have refactored MSBuild internals — `ProjectCacheService.DisposeAsync`
    // ABI changed — and load with a TypeLoadException at startup. Prefer
    // .NET 8 / 9 SDKs and only fall back to newer ones if nothing in that
    // range is installed.
    fn tier(major: u32) -> u8 {
        match major {
            8 => 0,  // best — LTS, what OmniSharp was built against
            9 => 1,  // OK — usually compatible
            _ => 2,  // last resort
        }
    }

    let mut best: Option<(u8, Vec<u32>, PathBuf)> = None;
    for root in candidate_roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            // SDK folders look like "8.0.413" / "9.0.100" — only take ones
            // starting with a digit so we don't pick up "NuGetFallbackFolder".
            if !name
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
            {
                continue;
            }
            let msbuild = entry.path().join("MSBuild.dll");
            if !msbuild.is_file() {
                continue;
            }
            let parts: Vec<u32> = name
                .split('.')
                .map(|s| s.parse::<u32>().unwrap_or(0))
                .collect();
            let major = parts.first().copied().unwrap_or(0);
            let candidate_tier = tier(major);
            let candidate_key = (candidate_tier, parts, msbuild);
            match &best {
                Some(existing) => {
                    // Prefer lower tier (8 > 9 > others); within the same
                    // tier, prefer newer point release.
                    if (candidate_key.0, &candidate_key.1)
                        < (existing.0, &existing.1)
                        || (candidate_key.0 == existing.0
                            && candidate_key.1 > existing.1)
                    {
                        best = Some(candidate_key);
                    }
                }
                None => best = Some(candidate_key),
            }
        }
    }

    best.map(|(_, _, path)| path)
}
