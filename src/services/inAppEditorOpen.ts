// SPDX-License-Identifier: GPL-3.0-or-later
//
// inAppEditorOpen — route `.cs` (and friends) "open in editor" requests
// to Locus's own Monaco editor instead of the OS system-default app.
//
// Why this exists
// ----------------
// The previous behaviour routed *all* "open in editor" requests through
// the `open_file_external` Tauri command, which on Windows uses
// `cmd /c start "" "<path>"` (see `commands/knowledge.rs::open_file_native`).
// For `.cs` files that hands the file off to Visual Studio / Unity — fine
// for a one-off, terrible as a default for a tool that ships its own
// Roslyn-backed Monaco editor.
//
// This module centralises the in-app decision so every caller
// (ChatView code refs, ChatChangesPanel "open in editor", the ChatDiffReview
// window, CommitDetail, CollabView, AssetChip, etc.) gets the same behaviour
// for free — they all funnel through `services/unity::openFileExternal`.
//
// Cross-window routing
// --------------------
// Locus sub-windows (e.g. `ChatDiffReviewWindow`) have their own Pinia
// stores; their `useEditorStore()` is a *different* instance from the
// main window's. The Monaco view is mounted in the main window only.
// Sub-windows therefore `emit("locus:open-in-editor", { relPath })` and
// the main window's `useAppBootstrap.registerListeners` picks it up.
//
// Extension list is intentionally small (`.cs` only) — see INAPP_EDITOR_EXTS.

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { useEditorStore } from "../stores/editor";
import { useProjectStore } from "../stores/project";
import { useUiStore } from "../stores/ui";
import { isChatDiffReviewWindowLocation } from "./chatDiffReviewWindow";
import { hasTauriWindowRuntime } from "./tauriRuntime";

/**
 * Tauri event name for "open this file in Locus's Monaco editor".
 * Emitted by sub-windows; listened to by the main window.
 *
 * The `locus:` prefix matches the fork's existing convention for
 * JS-only cross-window events (e.g. `locus:open-in-editor`).
 */
export const INAPP_EDITOR_OPEN_EVENT = "locus:open-in-editor";

/** Payload carried by `INAPP_EDITOR_OPEN_EVENT`. */
export interface InAppEditorOpenPayload {
  /** Workspace-relative path (forward slashes). */
  relPath: string;
}

/**
 * File extensions that should default-open in Locus's Monaco editor
 * instead of the OS system-default app.
 *
 * Scope:
 *   - `cs`        — Unity C# code (Roslyn semantic tokens, csharp_field
 *                   decoration, goto-definition / references all live
 *                   in the in-app editor; routing to VS Code defeats
 *                   every Locus advantage for the file type the
 *                   product is built around).
 *   - `csproj`    — MSBuild C# project file (XML; Locus renders fine).
 *   - `sln`       — MSBuild solution file (plaintext; Locus renders).
 *   - `shader`    — Unity ShaderLab (text; Locus renders).
 *   - `hlsl`      — HLSL shader include / source (text; Locus renders).
 *
 * Add more here as the workflow demands (e.g. `compute`, `glsl`,
 * `ts`/`tsx`). Every addition changes the user-visible default for
 * "open in editor" buttons — the user can still explicitly hand any
 * file off to the system default via `showInFolder` + double-click.
 */
const INAPP_EDITOR_EXTS: ReadonlySet<string> = new Set([
  "cs",
  "csproj",
  "sln",
  "shader",
  "hlsl",
]);

/**
 * True iff `filePath`'s leaf extension matches an in-app editor extension.
 * Case-insensitive. Treats `.CS` and `.cs` the same; ignores path
 * separators so `./Scripts/Player.cs` and `C:/Foo/Player.cs` both match.
 */
export function shouldOpenInAppEditor(filePath: string): boolean {
  if (!filePath) return false;
  // Last `.` after the last separator — we want the leaf extension,
  // not dots in the directory name.
  const lastSep = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  const start = lastSep + 1;
  const dot = filePath.lastIndexOf(".", filePath.length);
  if (dot < start) return false;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return INAPP_EDITOR_EXTS.has(ext);
}

/**
 * Resolve a caller-supplied file path (absolute, repo-relative, or just
 * a leaf name) into a forward-slash relative path inside `workingDir`.
 *
 * Returns `null` when the file is unambiguously outside the workspace
 * — in that case the caller should fall back to the system default
 * (e.g. double-clicking in Unity).
 *
 * The mirroring Rust side is `commands/knowledge.rs::resolve_openable_file_ref_path`
 * — keep them roughly in sync if you add new cases.
 */
export function resolveInAppEditorRelPath(
  filePath: string,
  workingDir: string,
): string | null {
  if (!filePath) return null;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const fp = norm(filePath);
  const wd = norm(workingDir);

  if (!wd) {
    // No workspace — only accept bare leaf paths (no separators).
    // Anything with a `/` is treated as outside-workspace.
    return fp.includes("/") ? null : fp;
  }

  // Case-insensitive prefix match for Windows compatibility
  // (`C:\Foo` and `c:/foo` are the same directory).
  const fpLower = fp.toLowerCase();
  const wdLower = wd.toLowerCase();
  if (fpLower === wdLower) return ""; // workingDir itself — not a file
  if (fpLower.startsWith(wdLower + "/")) {
    return fp.slice(wd.length + 1);
  }

  // Anything without a drive letter and without a leading separator is
  // already-relative. Trust the caller's casing in this branch (relPaths
  // from the agent / chat code refs use the case on disk).
  const looksAbsolute = /^[a-z]:\//i.test(fp) || fp.startsWith("/");
  if (!looksAbsolute) {
    return fp;
  }

  // Absolute path that does not live under workingDir — caller will
  // fall back to the OS handler.
  return null;
}

/**
 * True iff this JS context is the main Locus window (vs a sub-window).
 *
 * The only sub-window known to invoke "open in editor" today is
 * `ChatDiffReviewWindow`. Add more checks here as new sub-windows
 * get the same affordance.
 */
function isMainLocusWindow(): boolean {
  if (typeof window === "undefined") return true;
  // In browser-only dev (`bun run dev`, no Tauri) there's no sub-window
  // concept — treat as main so the direct in-store path is taken.
  if (!hasTauriWindowRuntime()) return true;
  return !isChatDiffReviewWindowLocation();
}

/**
 * Open the given file in Locus's Monaco editor. The caller is expected
 * to have already gated on `shouldOpenInAppEditor`.
 *
 * - In the main window: drives `useEditorStore().openFile` and switches
 *   the UI to the editor tab. The file's model is created in the store;
 *   `MonacoHost.onMounted → syncModel` picks it up when EditorView mounts.
 * - In a sub-window: emits a Tauri event so the main window picks it up
 *   (its editor store is the one bound to the visible Monaco).
 *
 * If the file is outside `workingDir` (or `workingDir` is unset and the
 * path is non-leaf), this is a silent no-op — the caller is responsible
 * for falling back to the system-default IPC.
 */
export async function openInAppEditor(filePath: string): Promise<void> {
  const projectStore = useProjectStore();
  const workingDir = projectStore.workingDir;
  const rel = resolveInAppEditorRelPath(filePath, workingDir);
  if (rel == null) {
    // File is outside the workspace — let the caller fall through to
    // the system-default path. No warning: the resolved relPath is null
    // for a legitimate "open a Unity asset from outside the project" use
    // case, which we don't want to log spam for.
    return;
  }
  if (isMainLocusWindow()) {
    await openInAppEditorDirect(rel);
    return;
  }
  if (!hasTauriWindowRuntime()) {
    // Browser-only dev: sub-window concept doesn't apply, but also no
    // Tauri to emit through. Drop silently — same fallback semantics as
    // the main window.
    return;
  }
  try {
    await emit(INAPP_EDITOR_OPEN_EVENT, {
      relPath: rel,
    } satisfies InAppEditorOpenPayload);
  } catch (err) {
    console.warn("[inAppEditor] emit failed:", err);
  }
}

/**
 * Internal: drive the editor store + tab switch from the main window.
 * Exported for the bootstrap listener only.
 */
export async function openInAppEditorDirect(relPath: string): Promise<void> {
  const editorStore = useEditorStore();
  const uiStore = useUiStore();
  try {
    await editorStore.openFile(relPath);
  } catch (err) {
    console.error("[inAppEditor] openFile failed for", relPath, err);
    return;
  }
  // Mount the editor view (lazy) and switch the visible tab. The model
  // is already in the store from the await above; MonacoHost's onMounted
  // → syncModel will read `editorStore.active` and bind the model.
  uiStore.setTab("editor");
}

/**
 * Wire up the main-window listener for `INAPP_EDITOR_OPEN_EVENT`.
 * Returns a `UnlistenFn` that the caller should invoke on cleanup.
 *
 * Safe to call outside Tauri runtime — the `listen` call is a no-op
 * promise that resolves to a no-op disposer.
 */
export async function listenInAppEditorOpens(): Promise<UnlistenFn> {
  if (!hasTauriWindowRuntime()) {
    return () => {
      /* no-op outside Tauri */
    };
  }
  return await listen<InAppEditorOpenPayload>(
    INAPP_EDITOR_OPEN_EVENT,
    (event) => {
      const rel = event.payload?.relPath;
      if (!rel) return;
      void openInAppEditorDirect(rel);
    },
  );
}
