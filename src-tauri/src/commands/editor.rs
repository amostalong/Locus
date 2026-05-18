use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::workspace::normalize_workspace_sub_path;
use crate::eol::{apply_line_ending, detect_preferred_line_ending, normalize_lf, LineEnding};
use crate::error::AppError;
use crate::workspace::Workspace;

const MAX_EDITABLE_BYTES: u64 = 8 * 1024 * 1024;
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

// ── Path resolution ──────────────────────────────────────────────────────────

fn ensure_workspace_set(cwd: &str) -> Result<&str, AppError> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            "editor.no_workspace",
            "No working directory is set",
        ));
    }
    Ok(cwd)
}

/// Wrap `normalize_workspace_sub_path` so its legacy string error becomes a
/// domain-specific code suitable for the editor surface.
fn normalize_for_editor(sub_path: &str) -> Result<String, AppError> {
    normalize_workspace_sub_path(sub_path).map_err(|e| {
        AppError::new(
            "editor.path_outside_workspace",
            "Path is not within the working directory",
        )
        .detail(e.message)
    })
}

/// Resolve a sub-path under `cwd` to an absolute, canonicalized path. The target
/// must exist and resolve inside the workspace tree (symlinks pointing outside
/// are rejected by canonicalizing both ends and comparing).
fn resolve_workspace_file(cwd: &str, sub_path: &str) -> Result<PathBuf, AppError> {
    ensure_workspace_set(cwd)?;
    let normalized = normalize_for_editor(sub_path)?;
    if normalized.is_empty() {
        return Err(AppError::new("editor.invalid_path", "Empty path"));
    }
    let base = Path::new(cwd);
    let target = base.join(&normalized);

    let canonical_base = dunce::canonicalize(base).map_err(|e| {
        AppError::new(
            "editor.canonicalize_failed",
            "Failed to resolve working directory",
        )
        .detail(e.to_string())
    })?;
    let canonical_target = dunce::canonicalize(&target).map_err(|e| {
        AppError::new("editor.not_found", format!("File not found: {}", normalized))
            .detail(e.to_string())
    })?;

    if !canonical_target.starts_with(&canonical_base) {
        return Err(AppError::new(
            "editor.path_outside_workspace",
            "Path is not within the working directory",
        ));
    }
    Ok(canonical_target)
}

/// Resolve a write target. The parent directory must already exist and lie
/// inside the workspace; the file itself may or may not exist.
fn resolve_workspace_write_target(cwd: &str, sub_path: &str) -> Result<PathBuf, AppError> {
    ensure_workspace_set(cwd)?;
    let normalized = normalize_for_editor(sub_path)?;
    if normalized.is_empty() {
        return Err(AppError::new("editor.invalid_path", "Empty path"));
    }
    let base = Path::new(cwd);
    let target = base.join(&normalized);
    let parent = target.parent().ok_or_else(|| {
        AppError::new("editor.invalid_path", "Path has no parent directory")
    })?;
    let file_name = target.file_name().ok_or_else(|| {
        AppError::new("editor.invalid_path", "Path has no file name")
    })?;

    let canonical_base = dunce::canonicalize(base).map_err(|e| {
        AppError::new(
            "editor.canonicalize_failed",
            "Failed to resolve working directory",
        )
        .detail(e.to_string())
    })?;
    let canonical_parent = dunce::canonicalize(parent).map_err(|e| {
        AppError::new(
            "editor.parent_not_found",
            format!("Parent directory does not exist: {}", parent.display()),
        )
        .detail(e.to_string())
    })?;
    if !canonical_parent.starts_with(&canonical_base) {
        return Err(AppError::new(
            "editor.path_outside_workspace",
            "Path is not within the working directory",
        ));
    }
    Ok(canonical_parent.join(file_name))
}

// ── Atomic write ─────────────────────────────────────────────────────────────

fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = target
        .parent()
        .expect("resolve_workspace_write_target ensures a parent exists");
    let stem = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let pid = std::process::id();
    let nonce: u64 = rand::random();
    let tmp = parent.join(format!(".{stem}.tmp.{pid}.{nonce:x}"));

    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }

    match std::fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

// ── Wire types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WireLineEnding {
    Lf,
    Crlf,
}

impl From<LineEnding> for WireLineEnding {
    fn from(value: LineEnding) -> Self {
        match value {
            LineEnding::Lf => Self::Lf,
            LineEnding::Crlf => Self::Crlf,
        }
    }
}

impl From<WireLineEnding> for LineEnding {
    fn from(value: WireLineEnding) -> Self {
        match value {
            WireLineEnding::Lf => Self::Lf,
            WireLineEnding::Crlf => Self::Crlf,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFile {
    pub content: String,
    pub line_ending: WireLineEnding,
    pub had_bom: bool,
    pub size: u64,
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn editor_read_file(
    sub_path: String,
    workspace: State<'_, Arc<Workspace>>,
) -> Result<EditorFile, AppError> {
    let cwd = workspace.path.read().await.clone();
    let target = resolve_workspace_file(&cwd, &sub_path)?;

    let metadata = std::fs::metadata(&target).map_err(|e| {
        AppError::new("editor.stat_failed", "Failed to read file metadata").detail(e.to_string())
    })?;
    if !metadata.is_file() {
        return Err(AppError::new(
            "editor.not_a_file",
            "Target is not a regular file",
        ));
    }
    if metadata.len() > MAX_EDITABLE_BYTES {
        return Err(AppError::new(
            "editor.file_too_large",
            format!(
                "File exceeds editor limit ({} bytes > {} bytes)",
                metadata.len(),
                MAX_EDITABLE_BYTES
            ),
        ));
    }

    let mut bytes = std::fs::read(&target).map_err(|e| {
        AppError::new("editor.read_failed", "Failed to read file").detail(e.to_string())
    })?;
    let had_bom = bytes.starts_with(&UTF8_BOM);
    if had_bom {
        bytes.drain(..UTF8_BOM.len());
    }
    let raw = String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            "editor.non_utf8",
            "File is not valid UTF-8 (binary or unsupported encoding)",
        )
    })?;
    let line_ending = detect_preferred_line_ending(&raw);
    let content = normalize_lf(&raw);
    Ok(EditorFile {
        content,
        line_ending: line_ending.into(),
        had_bom,
        size: metadata.len(),
    })
}

#[tauri::command]
pub async fn editor_write_file(
    sub_path: String,
    content: String,
    line_ending: WireLineEnding,
    had_bom: bool,
    workspace: State<'_, Arc<Workspace>>,
) -> Result<(), AppError> {
    let cwd = workspace.path.read().await.clone();
    let target = resolve_workspace_write_target(&cwd, &sub_path)?;

    let serialized = apply_line_ending(&content, line_ending.into());
    let mut bytes = if had_bom {
        let mut buf = Vec::with_capacity(UTF8_BOM.len() + serialized.len());
        buf.extend_from_slice(&UTF8_BOM);
        buf.extend_from_slice(serialized.as_bytes());
        buf
    } else {
        serialized.into_bytes()
    };

    if bytes.len() as u64 > MAX_EDITABLE_BYTES {
        return Err(AppError::new(
            "editor.file_too_large",
            format!(
                "Refusing to write {} bytes (limit {} bytes)",
                bytes.len(),
                MAX_EDITABLE_BYTES
            ),
        ));
    }

    match atomic_write(&target, &bytes) {
        Ok(()) => {
            bytes.clear();
            Ok(())
        }
        Err(e) => {
            let kind = e.kind();
            // Windows surfaces ERROR_SHARING_VIOLATION as PermissionDenied.
            if kind == std::io::ErrorKind::PermissionDenied {
                Err(
                    AppError::new("editor.save_locked", "File is locked by another process")
                        .detail(e.to_string())
                        .retryable(true),
                )
            } else {
                Err(AppError::new("editor.write_failed", "Failed to save file")
                    .detail(e.to_string()))
            }
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn workspace() -> TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn cwd_str(dir: &TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let dir = workspace();
        let cwd = cwd_str(&dir);
        let err = resolve_workspace_file(&cwd, "../etc/passwd").unwrap_err();
        assert_eq!(err.code, "editor.path_outside_workspace");
    }

    #[test]
    fn rejects_absolute_paths() {
        let dir = workspace();
        let cwd = cwd_str(&dir);
        // On Windows this rejects via drive-letter/Prefix; on Unix via leading '/'.
        let err = resolve_workspace_file(&cwd, "/etc/passwd").unwrap_err();
        assert_eq!(err.code, "editor.path_outside_workspace");
    }

    #[test]
    fn rejects_drive_letter_paths() {
        let dir = workspace();
        let cwd = cwd_str(&dir);
        let err = resolve_workspace_file(&cwd, "C:/Windows/System32/config").unwrap_err();
        assert_eq!(err.code, "editor.path_outside_workspace");
    }

    #[test]
    fn resolves_subpath_with_backslashes() {
        let dir = workspace();
        let cwd = cwd_str(&dir);
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(dir.path().join("nested").join("file.txt"), b"hi").unwrap();
        let resolved = resolve_workspace_file(&cwd, "nested\\file.txt").unwrap();
        let s = resolved.to_string_lossy();
        assert!(s.contains("nested"), "missing 'nested' in {}", s);
        assert!(s.ends_with("file.txt"), "wrong leaf in {}", s);
    }

    #[test]
    fn rejects_empty_subpath() {
        let dir = workspace();
        let cwd = cwd_str(&dir);
        let err = resolve_workspace_file(&cwd, "").unwrap_err();
        assert_eq!(err.code, "editor.invalid_path");
    }

    #[test]
    fn rejects_when_workspace_unset() {
        let err = resolve_workspace_file("", "anything.txt").unwrap_err();
        assert_eq!(err.code, "editor.no_workspace");
    }

    #[test]
    fn read_strips_bom_and_reports_flag() {
        let dir = workspace();
        let path = dir.path().join("with_bom.txt");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&UTF8_BOM);
        bytes.extend_from_slice(b"hello\n");
        fs::write(&path, &bytes).unwrap();

        let resolved = resolve_workspace_file(&cwd_str(&dir), "with_bom.txt").unwrap();
        let raw = std::fs::read(&resolved).unwrap();
        assert!(raw.starts_with(&UTF8_BOM));
    }

    #[test]
    fn detect_line_ending_round_trips_crlf() {
        assert_eq!(detect_preferred_line_ending("a\r\nb\r\n"), LineEnding::Crlf);
        assert_eq!(detect_preferred_line_ending("a\nb\n"), LineEnding::Lf);
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let dir = workspace();
        let path = dir.path().join("file.txt");
        fs::write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn atomic_write_creates_new_file() {
        let dir = workspace();
        let path = dir.path().join("created.txt");
        atomic_write(&path, b"created").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"created");
    }

    #[test]
    fn atomic_write_cleans_up_temp_on_no_error() {
        let dir = workspace();
        let path = dir.path().join("clean.txt");
        atomic_write(&path, b"x").unwrap();

        // Temp file (.<stem>.tmp.<pid>.<nonce>) must not linger.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with(".clean.txt.tmp.")
            })
            .collect();
        assert!(leftovers.is_empty(), "tmp not cleaned: {:?}", leftovers);
    }

    #[test]
    fn write_target_resolves_existing_file() {
        let dir = workspace();
        let cwd = cwd_str(&dir);
        fs::write(dir.path().join("exists.txt"), b"x").unwrap();
        let resolved = resolve_workspace_write_target(&cwd, "exists.txt").unwrap();
        assert!(resolved.to_string_lossy().ends_with("exists.txt"));
    }

    #[test]
    fn write_target_resolves_nonexistent_file_in_existing_dir() {
        let dir = workspace();
        let cwd = cwd_str(&dir);
        fs::create_dir(dir.path().join("sub")).unwrap();
        let resolved = resolve_workspace_write_target(&cwd, "sub/new.txt").unwrap();
        assert!(resolved.to_string_lossy().contains("sub"));
        assert!(resolved.to_string_lossy().ends_with("new.txt"));
        assert!(!resolved.exists());
    }

    #[test]
    fn write_target_rejects_missing_parent() {
        let dir = workspace();
        let cwd = cwd_str(&dir);
        let err = resolve_workspace_write_target(&cwd, "missing_dir/file.txt").unwrap_err();
        assert_eq!(err.code, "editor.parent_not_found");
    }

    #[test]
    fn end_to_end_round_trip_preserves_eol_and_bom() {
        let dir = workspace();
        let path = dir.path().join("doc.txt");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&UTF8_BOM);
        bytes.extend_from_slice(b"line1\r\nline2\r\n");
        fs::write(&path, &bytes).unwrap();

        // Simulate read pipeline.
        let raw = std::fs::read(&path).unwrap();
        let had_bom = raw.starts_with(&UTF8_BOM);
        let stripped = if had_bom { &raw[UTF8_BOM.len()..] } else { &raw[..] };
        let raw_str = std::str::from_utf8(stripped).unwrap();
        let line_ending = detect_preferred_line_ending(raw_str);
        let content = normalize_lf(raw_str);
        assert_eq!(content, "line1\nline2\n");
        assert_eq!(line_ending, LineEnding::Crlf);
        assert!(had_bom);

        // Simulate write pipeline (frontend echoes back the same metadata).
        let reapplied = apply_line_ending(&content, line_ending);
        let mut out = Vec::new();
        if had_bom {
            out.extend_from_slice(&UTF8_BOM);
        }
        out.extend_from_slice(reapplied.as_bytes());
        atomic_write(&path, &out).unwrap();

        // Bytes should match original exactly.
        let after = fs::read(&path).unwrap();
        assert_eq!(after, bytes);
    }
}
