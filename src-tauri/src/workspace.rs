use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    #[serde(rename = "workspace_id", alias = "workspaceId")]
    pub workspace_id: String,
}

/// Workspace state. Splits the previously monolithic `working_dir` concept into:
/// - `workspace_root`: user-selected canonical root. Knowledge / skill / memory
///   are anchored here.
/// - `unity_root`: canonical Unity project root (resolved from `workspace_root`
///   via `resolve_unity_project_path`). Unity integration (asset_db, C# LSP,
///   native bridge, Unity monitor) is anchored here.
///
/// During the migration window (`path` is still present), legacy code can keep
/// reading `workspace.path` — it mirrors `unity_root`. Writes MUST go through
/// [`Workspace::set_unity_root`] or [`Workspace::set_workspace_root`] so both
/// fields stay in sync. The `path` field will be removed in P6 once all
/// callers have migrated to `unity_root` / `workspace_root`.
pub struct Workspace {
    /// User-selected canonical root. Knowledge base lives here.
    pub workspace_root: tokio::sync::RwLock<String>,
    /// Resolved Unity project root. Unity integration lives here.
    pub unity_root: tokio::sync::RwLock<String>,
    /// **Deprecated alias** for `unity_root`. Retained so the ~223 legacy
    /// `workspace.path.read().await` call sites keep compiling. Removed in P6.
    #[allow(dead_code)]
    pub path: tokio::sync::RwLock<String>,
    pub workspace_id: tokio::sync::RwLock<Option<String>>,
    generation: AtomicU64,
    generation_lock: Mutex<()>,
}

impl Workspace {
    /// Construct a workspace where `workspace_root == unity_root`. Used at app
    /// startup before the user has had a chance to set a custom workspace.
    pub fn new(path: String, workspace_id: Option<String>) -> Self {
        Self {
            workspace_root: tokio::sync::RwLock::new(path.clone()),
            unity_root: tokio::sync::RwLock::new(path.clone()),
            path: tokio::sync::RwLock::new(path),
            workspace_id: tokio::sync::RwLock::new(workspace_id),
            generation: AtomicU64::new(0),
            generation_lock: Mutex::new(()),
        }
    }

    /// Construct a workspace with separate `workspace_root` and `unity_root`.
    /// Used by `set_workspace` after path resolution.
    pub fn new_with_roots(
        workspace_root: String,
        unity_root: String,
        workspace_id: Option<String>,
    ) -> Self {
        Self {
            workspace_root: tokio::sync::RwLock::new(workspace_root),
            unity_root: tokio::sync::RwLock::new(unity_root.clone()),
            path: tokio::sync::RwLock::new(unity_root),
            workspace_id: tokio::sync::RwLock::new(workspace_id),
            generation: AtomicU64::new(0),
            generation_lock: Mutex::new(()),
        }
    }

    /// Atomically update `unity_root` and the deprecated `path` alias.
    /// Use this whenever legacy code needs to change the Unity root.
    pub async fn set_unity_root(&self, new_path: String) {
        *self.unity_root.write().await = new_path.clone();
        *self.path.write().await = new_path;
    }

    /// Update `workspace_root` (knowledge base anchor). Does NOT change
    /// `unity_root` — call `set_unity_root` separately if the Unity root
    /// also moved.
    pub async fn set_workspace_root(&self, new_path: String) {
        *self.workspace_root.write().await = new_path;
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn bump_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn lock_generation(&self) -> Result<WorkspaceGenerationGuard<'_>, String> {
        let guard = self
            .generation_lock
            .lock()
            .map_err(|e| format!("Workspace generation lock error: {}", e))?;
        Ok(WorkspaceGenerationGuard {
            workspace: self,
            _guard: guard,
        })
    }
}

pub struct WorkspaceGenerationGuard<'a> {
    workspace: &'a Workspace,
    _guard: MutexGuard<'a, ()>,
}

impl WorkspaceGenerationGuard<'_> {
    pub fn is_current(&self, generation: u64) -> bool {
        self.workspace.generation() == generation
    }

    pub fn bump_generation(&self) -> u64 {
        self.workspace.bump_generation()
    }
}

pub fn workspace_config_path(dir: &str) -> std::path::PathBuf {
    Path::new(dir).join("Locus").join("config.json")
}

pub fn read_workspace_config(dir: &str) -> Result<WorkspaceConfig, String> {
    let config_path = workspace_config_path(dir);
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read workspace config: {}", e))?;
    serde_json::from_str::<WorkspaceConfig>(&content)
        .map_err(|e| format!("Failed to parse workspace config: {}", e))
}

pub fn write_workspace_config(dir: &str, config: &WorkspaceConfig) -> Result<(), String> {
    let config_path = workspace_config_path(dir);
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Locus directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize workspace config: {}", e))?;
    std::fs::write(&config_path, &json)
        .map_err(|e| format!("Failed to write workspace config: {}", e))
}

fn extract_unity_yaml_scalar(content: &str, key: &str) -> Option<String> {
    let prefix = format!("{}:", key);
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        let value = trimmed.strip_prefix(&prefix)?.trim();
        let value = value.trim_matches('"').trim_matches('\'').trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

/// Read the Unity `ProjectSettings.asset` from a Unity project root and
/// return a stable seed derived from `productGUID` / `cloudProjectId`.
///
/// `unity_root` MUST point at a directory containing `ProjectSettings/`
/// (i.e. the resolved Unity project root, NOT a generic workspace root).
/// When the user picks a non-Unity workspace root, `load_or_create_workspace`
/// still resolves `unity_root` internally before calling this — callers do
/// not have to do it themselves.
fn unity_workspace_seed(unity_root: &str) -> Option<String> {
    let settings_path = Path::new(unity_root)
        .join("ProjectSettings")
        .join("ProjectSettings.asset");
    let content = std::fs::read_to_string(&settings_path).ok()?;

    for key in [
        "productGUID",
        "projectGUID",
        "projectGuid",
        "cloudProjectId",
    ] {
        if let Some(value) = extract_unity_yaml_scalar(&content, key) {
            return Some(format!("unity:{}={}", key, value));
        }
    }

    None
}

fn workspace_id_from_seed(seed: &str) -> String {
    let digest = blake3::hash(seed.as_bytes()).to_hex().to_string();
    format!("unity-{}", &digest[..24])
}

fn random_workspace_id() -> String {
    format!("workspace-{}", uuid::Uuid::new_v4().simple())
}

/// Generate a workspace_id. `unity_root` is the resolved Unity project root
/// (so the seed is stable across `slg_gameclient/` ↔ `slg_gameclient/Project`
/// workspace_root reshuffles — it always hashes the Unity GUID, never the
/// outer directory).
fn generated_workspace_id(unity_root: &str) -> String {
    unity_workspace_seed(unity_root)
        .map(|seed| workspace_id_from_seed(&seed))
        .unwrap_or_else(random_workspace_id)
}

/// Migrate `Locus/config.json` from the legacy `<unity_root>/Locus/` location
/// to the new `<workspace_root>/Locus/` location, if needed.
///
/// Trigger conditions (X strategy — user-approved automatic migration):
///   - `<workspace_root>/Locus/config.json` does not exist, AND
///   - `<workspace_root>` ≠ `<unity_root>` (otherwise nothing to migrate — the
///     legacy location IS the canonical location for the "老用户无感" path),
///   - AND `<unity_root>/Locus/config.json` exists.
///
/// Behaviour:
///   - `fs::rename` first (atomic on the same volume).
///   - Fall back to copy + delete on cross-volume rename failures.
///   - On success: write a marker at `<workspace_root>/Locus/.migration.json`
///     recording the source path so users can audit / undo manually.
///   - On any failure: log a warning and return Ok — the caller will create
///     a fresh config at the new location anyway.
///
/// `load_or_create_workspace` calls this before deciding whether to create
/// a new workspace_id, so existing users keep their session history.
pub(crate) fn migrate_workspace_config_from_unity_root(
    workspace_root: &str,
    unity_root: &str,
) -> Result<(), String> {
    if workspace_root == unity_root {
        // Same path — no migration needed (also covers the empty / first-launch case).
        return Ok(());
    }

    let new_path = workspace_config_path(workspace_root);
    if new_path.exists() {
        // Already migrated (or written by an earlier run).
        return Ok(());
    }

    let legacy_path = workspace_config_path(unity_root);
    if !legacy_path.exists() {
        // Nothing to migrate.
        return Ok(());
    }

    eprintln!(
        "[Workspace] migrating config: {} -> {}",
        legacy_path.display(),
        new_path.display()
    );

    // Ensure the destination directory exists (workspace_root/Locus/).
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination Locus dir: {}", e))?;
    }

    // Try rename first; fall back to copy + delete on cross-volume failures.
    match std::fs::rename(&legacy_path, &new_path) {
        Ok(()) => {}
        Err(rename_err) => {
            eprintln!(
                "[Workspace] rename failed ({}), falling back to copy",
                rename_err
            );
            std::fs::copy(&legacy_path, &new_path).map_err(|e| {
                format!(
                    "Failed to copy legacy config from {} to {}: {}",
                    legacy_path.display(),
                    new_path.display(),
                    e
                )
            })?;
            if let Err(remove_err) = std::fs::remove_file(&legacy_path) {
                eprintln!(
                    "[Workspace] warning: copied config but failed to remove legacy file ({}); user should clean up manually",
                    remove_err
                );
            }
        }
    }

    // Record the migration in a marker file inside the new Locus dir so users
    // (and CI) can verify the migration happened.
    let marker_path = new_path
        .parent()
        .map(|p| p.join(".migration.json"))
        .unwrap_or_else(|| new_path.clone());
    let marker = serde_json::json!({
        "migrated_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "source_path": legacy_path.to_string_lossy(),
        "destination_path": new_path.to_string_lossy(),
        "schema": "workspace-config-migration/v1",
    });
    if let Ok(json) = serde_json::to_string_pretty(&marker) {
        let _ = std::fs::write(&marker_path, json);
    }

    Ok(())
}

/// Load (or create) the workspace_id for a given `(workspace_root, unity_root)`
/// pair.
///
/// - `workspace_root`: the canonical user-selected root. `Locus/config.json`
///   lives here. Knowledge / skill / memory are anchored here.
/// - `unity_root`: the resolved Unity project root. Used as the seed for the
///   workspace_id (`productGUID` hash) so the id is stable when the user
///   reorganises the parent directory.
///
/// If the legacy `<unity_root>/Locus/config.json` exists but the new
/// `<workspace_root>/Locus/config.json` does not, this function
/// auto-migrates the file (see `migrate_workspace_config_from_unity_root`).
pub fn load_or_create_workspace(workspace_root: &str, unity_root: &str) -> Result<String, String> {
    // 1. Auto-migrate legacy config.json if the workspace_root differs from
    //    the unity_root (X strategy).
    if let Err(e) = migrate_workspace_config_from_unity_root(workspace_root, unity_root) {
        eprintln!("[Workspace] migration warning: {}", e);
    }

    let config_path = workspace_config_path(workspace_root);
    let mut should_write_config = !config_path.exists();

    match read_workspace_config(workspace_root) {
        Ok(cfg) if !cfg.workspace_id.is_empty() => {
            return Ok(cfg.workspace_id);
        }
        Ok(_) => {
            eprintln!("[Workspace] legacy config missing workspace_id, creating workspace id");
            should_write_config = true;
        }
        Err(err) => {
            if config_path.exists() {
                eprintln!("[Workspace] failed to read legacy config.json: {}", err);
            }
        }
    }

    // Seed is derived from unity_root (the Unity project GUID), so the id is
    // stable even when workspace_root moves around.
    let workspace_id = generated_workspace_id(unity_root);
    if should_write_config {
        write_workspace_config(
            workspace_root,
            &WorkspaceConfig {
                workspace_id: workspace_id.clone(),
            },
        )?;
    }
    eprintln!(
        "[Workspace] resolved workspace {} at workspace_root={} (unity_root={})",
        workspace_id, workspace_root, unity_root
    );
    Ok(workspace_id)
}

// ============================================================================
// Path resolution (P1 of workspace_root vs unity_root refactor)
// ============================================================================

/// Result of resolving a Unity project root from a user-selected path.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResolveUnityResult {
    /// Path resolved unambiguously. `unity_root` is canonical; `levels` is
    /// how many `parent()` steps we walked (0 = input was already a Unity
    /// root).
    Resolved { unity_root: String, levels: u8 },
    /// Multiple Unity projects found under the input; front-end must show a
    /// picker. Each candidate is canonical.
    Picker { candidates: Vec<String> },
    /// No Unity project found within the search radius.
    NotFound,
}

/// How many `parent()` steps to take when walking up looking for a Unity root.
const WALK_UP_MAX_LEVELS: u8 = 3;
/// How deep the BFS descends below the input when no ancestor matched.
const BFS_MAX_DEPTH: u8 = 2;
/// Hard cap on BFS candidates before we declare "Picker".
const BFS_MAX_RESULTS: usize = 5;
/// Directories that BFS skips — known to be huge or irrelevant to Unity
/// project discovery.
const BFS_SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".cache",
    "Library",
    "Temp",
    "Logs",
    ".idea",
    ".vscode",
    ".vs",
    "obj",
    "bin",
    "target",
    "dist",
    "build",
];

fn is_unity_project_dir(path: &Path) -> bool {
    path.join("Assets").is_dir() && path.join("ProjectSettings").is_dir()
}

/// Canonicalize a path for stable comparison. Returns `None` if the path
/// doesn't exist (dunce errors on missing files).
fn canonicalize_for_compare(p: &Path) -> Option<String> {
    dunce::canonicalize(p)
        .ok()
        .map(|cp| cp.to_string_lossy().to_string())
}

/// Resolve a Unity project root from a user-selected path.
///
/// Resolution order:
/// 1. The input itself contains `Assets/` + `ProjectSettings/`
///    → `Resolved { unity_root: input, levels: 0 }`.
/// 2. Walk up to `WALK_UP_MAX_LEVELS` ancestors; the first one containing
///    `Assets/` + `ProjectSettings/` wins (levels=1..N).
/// 3. Otherwise BFS depth `BFS_MAX_DEPTH` from the input looking for Unity
///    projects, skipping known-noise directories:
///    - 0 found → `NotFound`
///    - 1 found → `Resolved` (levels=0, treated as exact)
///    - >1 found → `Picker` (front-end asks user)
pub fn resolve_unity_project_path(input: &str) -> ResolveUnityResult {
    let canonical = match canonicalize_for_compare(Path::new(input)) {
        Some(c) => c,
        None => return ResolveUnityResult::NotFound,
    };

    // 1. self
    if is_unity_project_dir(Path::new(&canonical)) {
        return ResolveUnityResult::Resolved {
            unity_root: canonical,
            levels: 0,
        };
    }

    // 2. walk up
    let mut current = PathBuf::from(&canonical);
    for level in 1..=WALK_UP_MAX_LEVELS {
        match current.parent() {
            Some(parent) => {
                let parent_str = parent.to_string_lossy().to_string();
                if is_unity_project_dir(Path::new(&parent_str)) {
                    return ResolveUnityResult::Resolved {
                        unity_root: parent_str,
                        levels: level,
                    };
                }
                current = parent.to_path_buf();
            }
            None => break, // reached drive root on Windows or `/` on Unix
        }
    }

    // 3. BFS down
    let candidates = find_unity_projects_bfs(Path::new(&canonical));
    match candidates.len() {
        0 => ResolveUnityResult::NotFound,
        1 => ResolveUnityResult::Resolved {
            unity_root: candidates.into_iter().next().unwrap(),
            levels: 0,
        },
        _ => ResolveUnityResult::Picker { candidates },
    }
}

/// BFS descendants looking for Unity project roots, depth-limited and
/// result-capped.
fn find_unity_projects_bfs(root: &Path) -> Vec<String> {
    let mut candidates = Vec::new();
    let mut queue: std::collections::VecDeque<(PathBuf, u8)> = std::collections::VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));

    while let Some((dir, depth)) = queue.pop_front() {
        if candidates.len() >= BFS_MAX_RESULTS {
            break;
        }
        if depth > BFS_MAX_DEPTH {
            continue;
        }

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            if candidates.len() >= BFS_MAX_RESULTS {
                break;
            }
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if BFS_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }

            if is_unity_project_dir(&path) {
                if let Some(canonical) = canonicalize_for_compare(&path) {
                    candidates.push(canonical);
                }
            } else if depth < BFS_MAX_DEPTH {
                queue.push_back((path, depth + 1));
            }
        }
    }

    candidates
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{
        generated_workspace_id, load_or_create_workspace, read_workspace_config,
        resolve_unity_project_path, ResolveUnityResult, Workspace, WorkspaceConfig,
    };

    fn write_project_settings(root: &tempfile::TempDir, body: &str) {
        let settings_dir = root.path().join("ProjectSettings");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::write(settings_dir.join("ProjectSettings.asset"), body).unwrap();
    }

    #[test]
    fn workspace_config_accepts_legacy_and_camel_case_keys() {
        let legacy = r#"{"workspace_id":"legacy-id","memory":{"enabled":true}}"#;
        let legacy_cfg: WorkspaceConfig =
            serde_json::from_str(legacy).expect("legacy workspace config should parse");
        assert_eq!(legacy_cfg.workspace_id, "legacy-id");

        let camel = r#"{"workspaceId":"camel-id","memory":{"enabled":false}}"#;
        let camel_cfg: WorkspaceConfig =
            serde_json::from_str(camel).expect("camelCase workspace config should parse");
        assert_eq!(camel_cfg.workspace_id, "camel-id");
    }

    #[test]
    fn workspace_config_serializes_workspace_id_in_snake_case() {
        let cfg = WorkspaceConfig {
            workspace_id: "stable-id".to_string(),
        };
        let value = serde_json::to_value(&cfg).expect("workspace config should serialize");
        assert_eq!(
            value.get("workspace_id").and_then(|v| v.as_str()),
            Some("stable-id")
        );
        assert!(value.get("workspaceId").is_none());
        assert!(value.get("memory").is_none());
    }

    #[test]
    fn workspace_generation_advances_on_bump() {
        let workspace = Workspace::new("A".to_string(), Some("workspace-a".to_string()));
        let initial = workspace.generation();
        assert_eq!(workspace.bump_generation(), initial + 1);
        assert_eq!(workspace.generation(), initial + 1);
    }

    #[test]
    fn generated_workspace_id_prefers_unity_project_guid_like_fields() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        write_project_settings(
            &dir_a,
            "PlayerSettings:\n  productGUID: 2d9a8f42f0da40f2a22b9c4c93ce7d34\n",
        );
        write_project_settings(
            &dir_b,
            "PlayerSettings:\n  productGUID: 2d9a8f42f0da40f2a22b9c4c93ce7d34\n",
        );

        let left = generated_workspace_id(&dir_a.path().to_string_lossy());
        let right = generated_workspace_id(&dir_b.path().to_string_lossy());
        assert_eq!(left, right);
    }

    #[test]
    fn generated_workspace_id_falls_back_to_random_id_without_unity_guid() {
        let dir = tempfile::tempdir().unwrap();
        write_project_settings(
            &dir,
            "PlayerSettings:\n  companyName: OpenAI\n  productName: Locus\n  applicationIdentifier:\n    Standalone: com.openai.locus\n",
        );

        let id = generated_workspace_id(&dir.path().to_string_lossy());
        assert!(id.starts_with("workspace-"));
        assert_eq!(id.len(), "workspace-".len() + 32);
    }

    #[test]
    fn load_or_create_workspace_persists_random_id_without_unity_guid() {
        let dir = tempfile::tempdir().unwrap();
        write_project_settings(
            &dir,
            "PlayerSettings:\n  companyName: OpenAI\n  productName: Locus\n  applicationIdentifier:\n    Standalone: com.openai.locus\n",
        );

        let path = dir.path().to_string_lossy().to_string();
        // Tempdir IS the Unity project root — workspace_root == unity_root.
        let first = load_or_create_workspace(&path, &path).unwrap();
        let second = load_or_create_workspace(&path, &path).unwrap();
        let cfg = read_workspace_config(&path).unwrap();

        assert!(first.starts_with("workspace-"));
        assert_eq!(first, second);
        assert_eq!(cfg.workspace_id, first);
    }

    #[test]
    fn load_or_create_workspace_persists_unity_guid_id_when_config_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        write_project_settings(
            &dir,
            "PlayerSettings:\n  productGUID: 2d9a8f42f0da40f2a22b9c4c93ce7d34\n",
        );

        let path = dir.path().to_string_lossy().to_string();
        let workspace_id = load_or_create_workspace(&path, &path).unwrap();
        let cfg = read_workspace_config(&path).unwrap();

        assert!(workspace_id.starts_with("unity-"));
        assert_eq!(cfg.workspace_id, workspace_id);
    }

    #[test]
    fn load_or_create_workspace_auto_migrates_legacy_unity_root_config() {
        // Simulate the "user upgraded from P1 — config.json lives at the
        // legacy <unity_root>/Locus/ location" case. After the call, the
        // config should live at <workspace_root>/Locus/config.json, and a
        // migration marker should be present.
        let tmp = tempfile::tempdir().unwrap();
        let workspace_root = tmp.path().join("ws_root");
        let unity_root = workspace_root.join("Project");
        std::fs::create_dir_all(unity_root.join("ProjectSettings")).unwrap();
        std::fs::write(
            unity_root.join("ProjectSettings").join("ProjectSettings.asset"),
            "PlayerSettings:\n  productGUID: aaaaaaaa111122223333444455556666\n",
        )
        .unwrap();

        // Pre-seed a legacy config at <unity_root>/Locus/config.json.
        let legacy_config_path = unity_root.join("Locus").join("config.json");
        std::fs::create_dir_all(legacy_config_path.parent().unwrap()).unwrap();
        std::fs::write(
            &legacy_config_path,
            r#"{"workspace_id":"legacy-id-aaa"}"#,
        )
        .unwrap();

        let ws_str = workspace_root.to_string_lossy().to_string();
        let un_str = unity_root.to_string_lossy().to_string();
        let id = load_or_create_workspace(&ws_str, &un_str).unwrap();

        // Same id (auto-migrated from the legacy file, not regenerated).
        assert_eq!(id, "legacy-id-aaa");
        // Config now lives at workspace_root/Locus/.
        let new_path = workspace_root.join("Locus").join("config.json");
        assert!(new_path.exists(), "config should be migrated to workspace_root");
        let cfg = read_workspace_config(&ws_str).unwrap();
        assert_eq!(cfg.workspace_id, "legacy-id-aaa");
        // Marker file records the migration.
        let marker = workspace_root.join("Locus").join(".migration.json");
        assert!(marker.exists(), "migration marker should be written");
        // Legacy file removed.
        assert!(!legacy_config_path.exists(), "legacy config should be moved, not copied");
    }

    #[test]
    fn load_or_create_workspace_noop_when_workspace_root_equals_unity_root() {
        // The "legacy" path where workspace_root == unity_root (老用户无感).
        // In this case no migration should happen even if legacy-style config
        // exists at that single location.
        let tmp = tempfile::tempdir().unwrap();
        write_project_settings(
            &tmp,
            "PlayerSettings:\n  productGUID: bbbbbbbb111122223333444455556666\n",
        );
        let path = tmp.path().to_string_lossy().to_string();
        let id = load_or_create_workspace(&path, &path).unwrap();

        assert!(id.starts_with("unity-"));
        // No migration marker when workspace_root == unity_root.
        let marker = tmp.path().join("Locus").join(".migration.json");
        assert!(
            !marker.exists(),
            "no migration marker should be written when workspace_root == unity_root"
        );
    }

    // ------------------------------------------------------------------
    // resolve_unity_project_path (P1 of workspace_root vs unity_root)
    // ------------------------------------------------------------------

    /// Helper: turn a TempDir into a minimal Unity project (Assets/ +
    /// ProjectSettings/) and return the path.
    fn make_unity_project(root: &tempfile::TempDir) -> std::path::PathBuf {
        let p = root.path().to_path_buf();
        fs::create_dir_all(p.join("Assets")).unwrap();
        fs::create_dir_all(p.join("ProjectSettings")).unwrap();
        p
    }

    #[test]
    fn resolve_returns_exact_when_input_is_unity_root() {
        let tmp = tempfile::tempdir().unwrap();
        let unity_root = make_unity_project(&tmp);

        let result = resolve_unity_project_path(unity_root.to_str().unwrap());
        match result {
            ResolveUnityResult::Resolved { levels, .. } => {
                assert_eq!(levels, 0, "input was already a Unity root");
            }
            other => panic!("expected Resolved, got {:?}", other),
        }
    }

    #[test]
    fn resolve_walks_up_to_find_unity_ancestor() {
        let tmp = tempfile::tempdir().unwrap();
        let unity_root = make_unity_project(&tmp);
        // /unity_root/Assets/Scripts/Player — 2 levels deep
        let nested = unity_root.join("Assets").join("Scripts").join("Player");
        fs::create_dir_all(&nested).unwrap();

        let result = resolve_unity_project_path(nested.to_str().unwrap());
        match result {
            ResolveUnityResult::Resolved { levels, unity_root: r } => {
                assert_eq!(
                    levels, 3,
                    "Player → Scripts → Assets → unity_root = 3 parents"
                );
                // Resolved path is the parent (unity_root), not the input.
                let input_path = std::path::Path::new(nested.to_str().unwrap());
                let resolved_path = std::path::Path::new(&r);
                assert_eq!(
                    resolved_path.parent(),
                    input_path.parent().and_then(|p| p.parent()).and_then(|p| p.parent()).and_then(|p| p.parent())
                );
            }
            other => panic!("expected Resolved (walked up), got {:?}", other),
        }
    }

    #[test]
    fn resolve_stops_walk_up_after_three_levels() {
        let tmp = tempfile::tempdir().unwrap();
        let unity_root = make_unity_project(&tmp);
        // /unity_root/a/b/c/d — 4 levels deep, exceeds WALK_UP_MAX_LEVELS=3
        let deep = unity_root.join("a").join("b").join("c").join("d");
        fs::create_dir_all(&deep).unwrap();
        // BFS won't find anything (d is a leaf and the path contains nothing
        // that looks like a Unity project below it).

        let result = resolve_unity_project_path(deep.to_str().unwrap());
        assert_eq!(
            result,
            ResolveUnityResult::NotFound,
            "4-level walk-up exceeds WALK_UP_MAX_LEVELS=3; expect NotFound"
        );
    }

    #[test]
    fn resolve_returns_picker_when_multiple_unity_descendants() {
        let tmp = tempfile::tempdir().unwrap();
        // Two sibling Unity projects under the parent.
        for name in ["GameA", "GameB"] {
            let game = tmp.path().join(name);
            fs::create_dir_all(game.join("Assets")).unwrap();
            fs::create_dir_all(game.join("ProjectSettings")).unwrap();
        }

        let result = resolve_unity_project_path(tmp.path().to_str().unwrap());
        match result {
            ResolveUnityResult::Picker { candidates } => {
                assert_eq!(candidates.len(), 2, "two Unity siblings → Picker");
                let names: Vec<String> = candidates
                    .iter()
                    .filter_map(|c| std::path::Path::new(c).file_name())
                    .map(|n| n.to_string_lossy().to_string())
                    .collect();
                assert!(names.contains(&"GameA".to_string()));
                assert!(names.contains(&"GameB".to_string()));
            }
            other => panic!("expected Picker, got {:?}", other),
        }
    }

    #[test]
    fn resolve_returns_not_found_when_no_unity_in_range() {
        let tmp = tempfile::tempdir().unwrap();
        // No Assets/ + ProjectSettings/ within 3 up / 2 down.
        let loose = tmp.path().join("loose");
        fs::create_dir_all(&loose).unwrap();

        let result = resolve_unity_project_path(loose.to_str().unwrap());
        assert_eq!(result, ResolveUnityResult::NotFound);
    }

    #[test]
    fn resolve_bfs_skips_node_modules_and_git() {
        let tmp = tempfile::tempdir().unwrap();
        // Plant fake Unity projects inside noise directories — BFS must skip them.
        for noise in ["node_modules", ".git", "Library"] {
            let noise_dir = tmp.path().join(noise);
            fs::create_dir_all(noise_dir.join("Assets")).unwrap();
            fs::create_dir_all(noise_dir.join("ProjectSettings")).unwrap();
        }

        let result = resolve_unity_project_path(tmp.path().to_str().unwrap());
        assert_eq!(
            result,
            ResolveUnityResult::NotFound,
            "noise dirs (node_modules/.git/Library) must be skipped by BFS"
        );
    }

    #[tokio::test]
    async fn workspace_setter_keeps_path_alias_in_sync() {
        // The deprecated `path` field must mirror `unity_root` so legacy
        // `workspace.path.read().await` callers keep returning the correct
        // value during the migration window.
        let ws = Workspace::new("init".to_string(), None);
        ws.set_unity_root("new-unity-root".to_string()).await;
        assert_eq!(ws.unity_root.read().await.as_str(), "new-unity-root");
        assert_eq!(
            ws.path.read().await.as_str(),
            "new-unity-root",
            "deprecated path alias must mirror unity_root"
        );

        // workspace_root is independent (knowledge base anchor).
        ws.set_workspace_root("new-workspace-root".to_string()).await;
        assert_eq!(ws.workspace_root.read().await.as_str(), "new-workspace-root");
        // path alias must NOT mirror workspace_root (it tracks unity_root only).
        assert_eq!(
            ws.path.read().await.as_str(),
            "new-unity-root",
            "path alias must NOT follow workspace_root"
        );
    }
}
