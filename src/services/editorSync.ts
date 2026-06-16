// EditorSync: bridges Monaco model lifecycle to the Roslyn language
// server's textDocument/didOpen / didChange / didClose protocol.
//
// Why this exists: switching from monaco-languageclient (which auto-
// wired onDidOpenTextDocument / onDidChangeTextDocument / onWillDispose)
// to a hand-rolled bridge left the language server blind to edits —
// it kept serving diagnostics / hover / references against the
// version of the file that was on disk when the bridge first saw it.
// This service is the explicit replacement for that implicit wiring.
//
// Behavior:
//   - Tracks every monaco.ITextModel whose language is csharp.
//   - Debounces content changes (200 ms) before pushing to Roslyn so
//     a fast typist doesn't flood the server with 60 didChange/sec.
//     The backend LspClient already collapses consecutive identical
//     opens via blake3 hashing, so 200 ms is a sanity cap, not a
//     correctness requirement.
//   - Mirrors the URI scheme that `bridge_lsp_request` already
//     canonicalizes (Roslyn stores documents under `file:///C:/...`;
//     the path on the wire is the absolute file system path, not
//     the Monaco `monaco.Uri.toString()`).
//   - On model disposal, sends a single didClose. The LspClient's
//     open_docs map is the source of truth for "is this open on the
//     server side" — closing a model that was never opened is a
//     no-op on the wire.

import type * as monaco from "monaco-editor";
import { csharpLspNotifyChange, csharpLspNotifyClose } from "./csharpLsp";

const DEBOUNCE_MS = 200;

interface SyncEntry {
  /** Absolute file-system path of the model (the wire side of URI). */
  path: string;
  /** Debounce timer for an in-flight didChange push. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Did we ever push a didOpen for this model? Used for logging only. */
  opened: boolean;
}

const entries = new Map<monaco.editor.ITextModel, SyncEntry>();

/**
 * Convert a Monaco URI to the absolute file-system path the
 * Roslyn-side LspClient expects. We use `fsPath` (Monaco's getter
 * resolves the file:// URI back to a platform-native path) instead
 * of `toString()` because Roslyn's `path_to_uri` produces a
 * `file:///C:/...` form that does not round-trip cleanly through
 * the URL-encoded form Monaco emits.
 */
function uriToFsPath(uri: monaco.Uri): string | null {
  const fsPath = uri.fsPath;
  if (!fsPath) return null;
  return fsPath;
}

function isCsharpModel(model: monaco.editor.ITextModel): boolean {
  return model.getLanguageId() === "csharp";
}

function schedulePush(model: monaco.editor.ITextModel): void {
  const entry = entries.get(model);
  if (!entry) return;
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    csharpLspNotifyChange(entry.path).then(
      () => { entry.opened = true; },
      (err) => console.warn(`[EditorSync] didChange failed for ${entry.path}:`, err),
    );
  }, DEBOUNCE_MS);
}

/**
 * Start tracking a Monaco model. Safe to call multiple times for
 * the same model — subsequent calls are no-ops.
 */
export function trackModel(model: monaco.editor.ITextModel): void {
  if (entries.has(model)) return;
  if (!isCsharpModel(model)) return;
  const path = uriToFsPath(model.uri);
  if (!path) return;
  const entry: SyncEntry = { path, timer: null, opened: false };
  entries.set(model, entry);
  // Push the initial content so the server has the file open before
  // any hover / goto query hits it. This is the equivalent of MLC's
  // onDidOpenTextDocument hook.
  csharpLspNotifyChange(path).then(
    () => { entry.opened = true; },
    (err) => console.warn(`[EditorSync] initial didOpen failed for ${path}:`, err),
  );
  // Debounced push on every content change.
  model.onDidChangeContent(() => schedulePush(model));
  // didClose on dispose.
  model.onWillDispose(() => untrackModel(model));
}

/**
 * Stop tracking a model. Pushes didClose so Roslyn can release its
 * internal document. Safe to call multiple times.
 */
export function untrackModel(model: monaco.editor.ITextModel): void {
  const entry = entries.get(model);
  if (!entry) return;
  entries.delete(model);
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (!entry.opened) {
    // Never opened on the server side — don't bother with didClose.
    return;
  }
  csharpLspNotifyClose(entry.path).catch(
    (err) => console.warn(`[EditorSync] didClose failed for ${entry.path}:`, err),
  );
}

/**
 * Track every csharp model currently in the editor. Called by
 * MonacoHost on mount (and on workspace switch) so models that
 * existed before EditorSync was loaded still get pushed to Roslyn.
 */
export function trackAllCurrentModels(getModels: () => monaco.editor.ITextModel[]): void {
  for (const m of getModels()) trackModel(m);
}

/**
 * Drop all tracking state. Called on workspace switch / teardown.
 * Does not push didClose for the dropped models — the next workspace
 * will open its own copies.
 */
export function reset(): void {
  for (const [, entry] of entries) {
    if (entry.timer !== null) clearTimeout(entry.timer);
  }
  entries.clear();
}
