use std::sync::Arc;

use tauri::State;

use crate::error::AppError;
use crate::logging::{AppLogEntry, AppLogStore};

const DEFAULT_LOG_FETCH_LIMIT: usize = 2_000;
const FRONTEND_LOG_MAX_BATCH: usize = 256;
const FRONTEND_LOG_MAX_FIELD_CHARS: usize = 200;
const FRONTEND_LOG_MAX_MESSAGE_CHARS: usize = 16_000;

#[tauri::command]
pub async fn get_log_entries(
    limit: Option<usize>,
    logs: State<'_, Arc<AppLogStore>>,
) -> Result<Vec<AppLogEntry>, AppError> {
    let limit = limit
        .unwrap_or(DEFAULT_LOG_FETCH_LIMIT)
        .clamp(1, DEFAULT_LOG_FETCH_LIMIT);
    Ok(logs.snapshot(limit))
}

#[tauri::command]
pub async fn clear_log_entries(logs: State<'_, Arc<AppLogStore>>) -> Result<(), AppError> {
    logs.clear();
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogLine {
    pub timestamp_ms: i64,
    pub level: String,
    pub module: String,
    pub message: String,
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let truncated: String = value.chars().take(max_chars).collect();
    format!("{truncated} …(truncated)")
}

/// Normalizes one frontend-reported line into the shared log entry shape.
/// Level falls back to `info` outside the known set; module and message are
/// bounded so a runaway frontend loop cannot flood the file with huge lines.
pub(crate) fn sanitize_frontend_log_line(line: &FrontendLogLine) -> AppLogEntry {
    let level = match line.level.to_ascii_lowercase().as_str() {
        level @ ("trace" | "debug" | "info" | "warn" | "error") => level.to_string(),
        _ => "info".to_string(),
    };
    let module = truncate_chars(line.module.trim(), FRONTEND_LOG_MAX_FIELD_CHARS);
    let module = if module.is_empty() {
        "frontend".to_string()
    } else {
        module
    };
    AppLogEntry {
        id: String::new(),
        timestamp_ms: line.timestamp_ms,
        level,
        source: "frontend".to_string(),
        module: module.clone(),
        target: module,
        message: truncate_chars(&line.message, FRONTEND_LOG_MAX_MESSAGE_CHARS),
    }
}

/// Frontend console lines are mirrored here so they land in the persistent
/// log file next to backend output. They intentionally do not re-enter the
/// in-memory store: the debug console already holds them on the JS side.
///
/// Additionally, each forwarded line is re-emitted via `tracing::*!` so the
/// `bun tauri dev` PowerShell window sees the JS-side diagnostics live,
/// matching the level mapping used by `debugConsole.ts` (log→info,
/// info→info, warn→warn, error→error, debug→debug). `allow_level` gates
/// DEBUG/TRACE through the existing `LOCUS_DEBUG` env flag.
#[tauri::command]
pub async fn append_frontend_logs(
    entries: Vec<FrontendLogLine>,
    dropped_count: Option<u64>,
    logs: State<'_, Arc<AppLogStore>>,
) -> Result<(), AppError> {
    // Diagnostic probe: emitted unconditionally before any branching so we
    // can confirm whether the Tauri command is being invoked from the
    // webview at all. If this never appears in the terminal, the JS side
    // never reaches `invoke("append_frontend_logs", ...)` and the problem
    // is upstream (debugConsole.ts capture / batch flush / IPC plumbing).
    eprintln!(
        "[FE_LOG] PROBE append_frontend_logs called count={} dropped={:?} file_sink={}",
        entries.len(),
        dropped_count,
        logs.file_sink().is_some(),
    );

    let Some(sink) = logs.file_sink() else {
        eprintln!("[FE_LOG] PROBE early-return: file_sink is None");
        return Ok(());
    };
    if let Some(dropped) = dropped_count.filter(|count| *count > 0) {
        let line = FrontendLogLine {
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
            level: "warn".to_string(),
            module: "debugConsole".to_string(),
            message: format!("{dropped} frontend log line(s) dropped before forwarding"),
        };
        sink.enqueue(sanitize_frontend_log_line(&line));
        tracing::warn!("[debugConsole] {dropped} frontend log line(s) dropped before forwarding");
    }
    for line in entries.iter().take(FRONTEND_LOG_MAX_BATCH) {
        let sanitized = sanitize_frontend_log_line(line);
        sink.enqueue(sanitized.clone());
        emit_frontend_to_tracing(&sanitized);
    }
    Ok(())
}

/// Re-emit a sanitized frontend log line through `tracing::*!` so the Rust
/// tracing layer (and therefore the `bun tauri dev` terminal) sees it. The
/// level string is normalized to lowercase by `sanitize_frontend_log_line`,
/// so the match is exhaustive over the documented set.
///
/// Also writes a tagged line to **stderr** (`[FE_LOG] ...`). `tracing`'s
/// default fmt writer targets stdout, which `tauri dev` on Windows does
/// not always forward to the parent PowerShell terminal; stderr is
/// reliably inherited from the child process. The `FE_LOG` prefix makes
/// it greppable and lets you verify the function is being invoked even
/// if tracing ends up filtered or routed elsewhere.
fn emit_frontend_to_tracing(entry: &AppLogEntry) {
    let prefixed = format!("[{}] {}", entry.module, entry.message);
    match entry.level.as_str() {
        "error" => {
            tracing::error!("{prefixed}");
            eprintln!("[FE_LOG] ERROR {prefixed}");
        }
        "warn" => {
            tracing::warn!("{prefixed}");
            eprintln!("[FE_LOG] WARN  {prefixed}");
        }
        "info" => {
            tracing::info!("{prefixed}");
            eprintln!("[FE_LOG] INFO  {prefixed}");
        }
        "debug" => {
            tracing::debug!("{prefixed}");
            eprintln!("[FE_LOG] DEBUG {prefixed}");
        }
        "trace" => {
            tracing::trace!("{prefixed}");
            eprintln!("[FE_LOG] TRACE {prefixed}");
        }
        _ => {
            tracing::info!("{prefixed}");
            eprintln!("[FE_LOG] INFO  {prefixed}");
        }
    }
}

/// Flushes pending lines and reveals `locus.log` in the file manager.
#[tauri::command]
pub async fn reveal_log_file(logs: State<'_, Arc<AppLogStore>>) -> Result<String, AppError> {
    let Some(sink) = logs.file_sink() else {
        return Err(AppError::new(
            "log.file.disabled",
            "Persistent file logging is not active",
        )
        .operation("revealLogFile"));
    };
    sink.flush_blocking(std::time::Duration::from_millis(500));
    let path = sink.log_path().to_path_buf();
    if !path.is_file() {
        return Err(
            AppError::new("log.file.missing", "Log file does not exist yet")
                .detail(path.to_string_lossy().to_string())
                .operation("revealLogFile"),
        );
    }
    crate::commands::reveal_path_native(&path).map_err(|error| {
        AppError::new("log.file.reveal_failed", "Failed to reveal log file")
            .detail(error)
            .operation("revealLogFile")
    })?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_log_export(file_path: String, content: String) -> Result<String, AppError> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err(
            AppError::new("log.export.empty_path", "Log export path is empty")
                .operation("saveLogExport"),
        );
    }

    let mut path = std::path::PathBuf::from(trimmed);
    let has_log_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("log"))
        .unwrap_or(false);
    if !has_log_extension {
        path.set_extension("log");
    }

    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            AppError::new(
                "log.export.create_dir_failed",
                "Failed to create log export directory",
            )
            .detail(error.to_string())
            .operation("saveLogExport")
        })?;
    }

    std::fs::write(&path, content.as_bytes()).map_err(|error| {
        AppError::new("log.export.write_failed", "Failed to write log export")
            .detail(error.to_string())
            .operation("saveLogExport")
    })?;

    eprintln!("[Locus] exported console log to {}", path.display());
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{sanitize_frontend_log_line, FrontendLogLine};

    fn line(level: &str, module: &str, message: &str) -> FrontendLogLine {
        FrontendLogLine {
            timestamp_ms: 1_750_000_000_000,
            level: level.to_string(),
            module: module.to_string(),
            message: message.to_string(),
        }
    }

    #[test]
    fn sanitize_keeps_known_levels_and_defaults_unknown_to_info() {
        assert_eq!(sanitize_frontend_log_line(&line("WARN", "m", "x")).level, "warn");
        assert_eq!(sanitize_frontend_log_line(&line("verbose", "m", "x")).level, "info");
    }

    #[test]
    fn sanitize_fills_empty_module_and_marks_source_frontend() {
        let entry = sanitize_frontend_log_line(&line("info", "   ", "x"));
        assert_eq!(entry.module, "frontend");
        assert_eq!(entry.source, "frontend");
    }

    #[test]
    fn sanitize_truncates_oversized_messages() {
        let entry = sanitize_frontend_log_line(&line("info", "m", &"喵".repeat(20_000)));
        assert!(entry.message.chars().count() < 20_000);
        assert!(entry.message.ends_with("…(truncated)"));
    }
}
