import { ipcInvoke } from "./ipc";

export interface DirEntry {
  relPath: string;
  name: string;
  isDir: boolean;
}

export interface DirEntriesPage {
  entries: DirEntry[];
  totalCount: number;
  nextOffset: number;
  hasMore: boolean;
}

export interface WorkspaceSearchEntry {
  relPath: string;
  name: string;
  parentPath: string;
  isDir: boolean;
  matchScore: number;
}

export type WorkspaceEntryKind = "file" | "folder" | "other" | "missing";

export interface WorkspaceEntryStat {
  path: string;
  exists: boolean;
  entryKind: WorkspaceEntryKind;
}

// ============================================================================
// workspace_root vs unity_root split (P5 of the refactor — see
// `locus-workspace-unity-roots.md` topic in agent memory).
//
// The new `setWorkspace` / `resolveUnityProjectPath` IPC pair replaces the
// legacy `setWorkingDir` String-returning call. The legacy function is kept
// here as a thin wrapper for back-compat (a few call sites still depend on
// its String return type) but the front-end should migrate to
// `setWorkspace` so it can:
//   1. Receive a structured result with both `workspaceRoot` and
//      `unityRoot` (the old `setWorkingDir` only returned `unityRoot`).
//   2. Detect multi-Unity-project parents via `resolveUnityProjectPath` and
//      show a picker before committing.
//   3. Surface a migration notice when the back-end moved the knowledge
//      base from the legacy `<unity_root>/Locus/knowledge/` location to
//      the new `<workspace_root>/Locus/knowledge/` location.
// ============================================================================

/** Result of a Unity-project path resolution attempt. */
export type ResolveUnityResult =
  | { kind: "resolved"; unityRoot: string; levels: number }
  | { kind: "picker"; candidates: string[] }
  | { kind: "notFound" };

/** What the back-end did when resolving the user-selected path. */
export type WorkspaceResolutionKind = "exact" | "walkedUp" | "pickerSelected";

/** Info about a knowledge-base migration that happened during setWorkspace. */
export interface WorkspaceMigrationInfo {
  source: string;
  destination: string;
  fileCount: number;
  bytes: number;
}

/** Structured result of `setWorkspace`. */
export interface SetWorkspaceResult {
  workspaceRoot: string;
  unityRoot: string;
  resolutionKind: WorkspaceResolutionKind;
  migration: WorkspaceMigrationInfo | null;
}

export function getWorkingDir(): Promise<string> {
  return ipcInvoke<string>("get_working_dir");
}

export function setWorkingDir(path: string): Promise<string> {
  return ipcInvoke<string>("set_working_dir", { path });
}

export function setWorkspace(path: string): Promise<SetWorkspaceResult> {
  return ipcInvoke<SetWorkspaceResult>("set_workspace", { path });
}

export function resolveUnityProjectPath(path: string): Promise<ResolveUnityResult> {
  return ipcInvoke<ResolveUnityResult>("resolve_unity_project_path", { path });
}

export function listRecentDirs(): Promise<string[]> {
  return ipcInvoke<string[]>("list_recent_dirs");
}

export function removeRecentDir(path: string): Promise<string[]> {
  return ipcInvoke<string[]>("remove_recent_dir", { path });
}

export function openDirInFileExplorer(path: string): Promise<void> {
  return ipcInvoke<void>("open_dir_in_file_explorer", { path });
}

export function listDirEntries(subPath: string): Promise<DirEntry[]> {
  return ipcInvoke<DirEntry[]>("list_dir_entries", { subPath });
}

export function listDirEntriesPage(
  subPath: string,
  offset = 0,
  limit = 200,
  excludeMeta = false,
): Promise<DirEntriesPage> {
  return ipcInvoke<DirEntriesPage>("list_dir_entries_page", {
    subPath,
    offset,
    limit,
    excludeMeta,
  });
}

export function searchWorkspaceEntries(
  query: string,
  limit = 200,
): Promise<WorkspaceSearchEntry[]> {
  return ipcInvoke<WorkspaceSearchEntry[]>("search_workspace_entries", { query, limit });
}

export function statWorkspaceEntries(paths: string[]): Promise<WorkspaceEntryStat[]> {
  return ipcInvoke<WorkspaceEntryStat[]>("stat_workspace_entries", { paths });
}

export function resetAllConfig(): Promise<void> {
  return ipcInvoke("reset_all_config");
}
