<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from "monaco-editor";

import { useEditorStore, type OpenFile } from "../../stores/editor";
import { createAnimationFrameResizeObserver } from "../../composables/resizeObserver";
import {
  ensureColorMapReady,
  ensureMonacoVscodeServices,
  ensureVisualTheme,
  fsProvider,
  setFsRoot,
} from "../../services/monacoVscodeServices";
import { findEnclosing, type EnclosingSymbol } from "../../services/codeRefDetect";
import { ipcInvoke } from "../../services/ipc";
import { useOmnisharpStatus } from "../../composables/useOmnisharpStatus";
import {
  csharpLspBridgeRequest,
  csharpLspGetStatus,
  subscribeCsharpLspStatus,
} from "../../services/csharpLsp";
import { trackAllCurrentModels, reset as resetEditorSync, trackModel } from "../../services/editorSync";
import { findInactiveRangesFromSource } from "../../services/preprocessorDimming";
import { getPreprocessorSymbols, getPreprocessorSymbolsFromCompletion } from "../../services/csharpLsp";
// 用于覆盖 Monaco 内部的 editor.action.findReferences 命令
// （vscode.commands.registerCommand 走的是 VS Code API 扩展主机桥，覆盖不了）
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import type { CodeRefAttachment, CodeRefKind } from "../../types";

const props = defineProps<{
  workingDir: string;
}>();

const editorStore = useEditorStore();
const container = ref<HTMLElement | null>(null);

const emit = defineEmits<{
  (e: "code-ref", payload: CodeRefAttachment): void;
}>();

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let resizeHandle: ReturnType<typeof createAnimationFrameResizeObserver> | null = null;
let themeObserver: MutationObserver | null = null;
let hasFunctionCtx: monaco.editor.IContextKey<boolean> | null = null;
let hasClassCtx: monaco.editor.IContextKey<boolean> | null = null;
let cursorListener: monaco.IDisposable | null = null;
let csharpClient: { workspaceDir: string; stop: () => Promise<void> } | null = null;
let csharpClientPending: Promise<void> | null = null;
let csharpStatusUnlisten: (() => void) | null = null;
const { setStatus: setOmniStatus, setName: setOmniName } = useOmnisharpStatus();

/** Monaco decorations collection for preprocessor inactive-range dimming. */
let preprocessorDecorations: monaco.editor.IEditorDecorationsCollection | null = null;
let dimModelListener: monaco.IDisposable | null = null;
let dimCursorListener: monaco.IDisposable | null = null;
/** Cached preprocessor symbols from the Rust backend (null = not yet loaded). */
let cachedSymbols: Set<string> | null = null;

// ── Monaco Provider Registration Tracking ─────────────────────────────
// Store ALL Monaco provider registration disposables so we can clean them
// up on component unmount. This prevents provider accumulation (and
// duplicate code lens / completion results) across LSP client restarts.
//
// Pattern: register → store disposable → dispose on unmount.
// See: https://github.com/microsoft/monaco-editor/issues/xxx
let monacoProviderDisposables: monaco.IDisposable[] = [];

// Tracks whether we've already hit the monaco-vscode-api 33.0.9 race where
// `vscode.commands.executeCommand('editor.action.showReferences', ...)` throws
// "Default api is not ready yet" because the localExtensionHost worker hasn't
// published the default API by the time the user fires Shift+F12. The race is
// stable on first use, the custom references widget is just as usable, and
// we don't want to spam the console every time references are looked up —
// warn once, debug thereafter.
let showReferencesApiBroken = false;

// Diagnostic flag for the references flow. Shift+F12 currently fails
// silently in several ways (LSP returns empty, editor is null mid-flow,
// widget rendered but invisible behind another stacking context, click
// fires but openFile hangs). Each of these now logs at least once via
// the [refDiag] tag so we can pinpoint which one is biting without
// re-reading the code. Mirror of `showReferencesApiBroken` — same
// warn-once-then-debug pattern.
let referencesDiagWarned = false;
function refDiag(level: "warn" | "debug", ...args: unknown[]): void {
  if (level === "warn" && !referencesDiagWarned) {
    referencesDiagWarned = true;
    console.warn("[refDiag] (further [refDiag] messages will be at debug level)", ...args);
  } else {
    console.debug("[refDiag]", ...args);
  }
}

/** Convert LSP 0-based range to Monaco 1-based range */
function lspRangeToMonaco(r: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}) {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

/**
 * Lightweight peek-references widget shown when the monaco-vscode
 * extension host hasn't published the default `vscode` API yet
 * (`Default api is not ready yet`). Renders an HTML list of locations
 * anchored to the cursor; clicking a row navigates the editor there.
 */
function showReferencesFallback(
  _originUri: monaco.Uri,
  originPos: monaco.Position,
  locations: Array<{ uri: monaco.Uri; range: monaco.IRange }>,
  sourceId: string,
): void {
  refDiag("debug", `enter sourceId=${sourceId} originPos=${originPos.lineNumber}:${originPos.column} locations=${locations.length}`);
  if (!editor) {
    refDiag("warn", "editor is null, bailing before render — references widget will not appear", {
      sourceId,
      originPos: { line: originPos.lineNumber, col: originPos.column },
      locations: locations.length,
    });
    return;
  }
  if (locations.length === 0) {
    refDiag("warn", "locations is empty, bailing before render — Roslyn returned no references", {
      sourceId,
      originPos: { line: originPos.lineNumber, col: originPos.column },
    });
    return;
  }

  // Group locations by file path so a project with 30 refs across 5
  // files shows as 5 file headers + 30 line rows (vscode-style peek
  // view). Empty `locations` short-circuits above — there's nothing
  // useful to render and an empty overlay would just look broken.
  const groups = new Map<string, Array<{ uri: monaco.Uri; range: monaco.IRange }>>();
  for (const loc of locations) {
    const key = loc.uri.fsPath;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(loc);
  }
  // Sort groups by file path so the order is stable across renders
  // (Roslyn doesn't promise an order on the wire).
  const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));

  const overlay = document.createElement("div");
  overlay.className = "locus-refs-overlay";
  // position:fixed with a high z-index keeps the widget on top of the
  // editor's stacking context (we deliberately avoid IContentWidget
  // here — monaco-vscode-api 33.0.9's ConfiguredStandaloneEditor
  // hits a `_widgets[getId()]` lookup miss in setWidgetPosition
  // that throws `Cannot read properties of undefined (reading
  // 'setPosition')`).
  overlay.style.cssText = [
    "position:fixed",
    "z-index:9999",
    "min-width:380px",
    "max-width:560px",
    "max-height:340px",
    "overflow:hidden",
    "display:flex",
    "flex-direction:column",
    "background:var(--vscode-editorWidget-background,#252526)",
    "color:var(--vscode-editorWidget-foreground,#cccccc)",
    "border:1px solid var(--vscode-editorWidget-border,#454545)",
    "border-radius:4px",
    "box-shadow:0 4px 16px rgba(0,0,0,0.5)",
    "font-family:var(--vscode-font-family,'Segoe UI',Tahoma,sans-serif)",
    "font-size:12px",
    "line-height:1.5",
  ].join(";");

  // ── Header: title + close button + count badge ──────────────────
  const header = document.createElement("div");
  header.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:space-between",
    "padding:6px 10px",
    "background:var(--vscode-editorWidget-header-background,#2d2d2d)",
    "border-bottom:1px solid var(--vscode-editorWidget-border,#454545)",
    "flex-shrink:0",
  ].join(";");
  const title = document.createElement("span");
  title.textContent = `${locations.length} reference${locations.length === 1 ? "" : "s"} · ${sourceId}`;
  title.style.cssText = "font-weight:600;color:var(--vscode-editorWidget-foreground,#cccccc);";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.title = "Close (Esc)";
  closeBtn.setAttribute("aria-label", "Close references");
  closeBtn.style.cssText = [
    "background:transparent",
    "border:0",
    "color:var(--vscode-icon-foreground,#cccccc)",
    "font-size:18px",
    "line-height:1",
    "cursor:pointer",
    "padding:0 4px",
    "border-radius:2px",
  ].join(";");
  closeBtn.addEventListener("click", cleanup);
  header.appendChild(closeBtn);
  overlay.appendChild(header);

  // ── Body: scrollable list of file groups + line rows ─────────────
  const body = document.createElement("div");
  body.style.cssText = "overflow-y:auto;flex:1 1 auto;";
  overlay.appendChild(body);

  const navigateTo = (loc: { uri: monaco.Uri; range: monaco.IRange }) => {
    const root = props.workingDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const target = loc.uri.fsPath.replace(/\\/g, "/");
    refDiag("debug", `row clicked uri=${loc.uri.fsPath} range=${loc.range.startLineNumber}:${loc.range.startColumn} inWorkspace=${target.toLowerCase().startsWith(root.toLowerCase())}`);
    if (target.toLowerCase().startsWith(root.toLowerCase())) {
      const rel = target.slice(root.length + 1);
      editorStore.openFile(rel).then((opened) => {
        refDiag("debug", `openFile resolved rel=${rel} opened=${!!opened}`);
        if (!opened) {
          refDiag("warn", "openFile returned falsy — editor.setPosition will land on the OLD model, not the target file", {
            rel,
            target: { line: loc.range.startLineNumber, col: loc.range.startColumn },
          });
        }
        editor?.setPosition({
          lineNumber: loc.range.startLineNumber,
          column: loc.range.startColumn,
        });
        editor?.revealPositionInCenter({
          lineNumber: loc.range.startLineNumber,
          column: loc.range.startColumn,
        });
        editor?.focus();
      }).catch((e) => console.warn("[refCmd] openFile failed:", e));
    } else {
      // Reference points outside the workspace (e.g. a Roslyn
      // decompilation in %TEMP%). Open as a read-only virtual tab.
      let m = monaco.editor.getModel(loc.uri);
      if (!m) m = monaco.editor.createModel("", "csharp", loc.uri);
      const fileName = loc.uri.path.split("/").pop() ?? loc.uri.fsPath;
      editorStore.openVirtualFile(loc.uri.toString(), fileName, m);
      editor?.setPosition({
        lineNumber: loc.range.startLineNumber,
        column: loc.range.startColumn,
      });
    }
  };

  for (const [path, locs] of sortedGroups) {
    const group = document.createElement("div");
    group.className = "locus-refs-group";
    group.style.cssText = "padding:4px 0 2px 0;";

    // File header row — non-clickable but visually anchors the group.
    const fileHeader = document.createElement("div");
    fileHeader.title = path;
    fileHeader.style.cssText = [
      "padding:2px 10px",
      "color:var(--vscode-editorWidget-foreground,#cccccc)",
      "background:var(--vscode-editorWidget-header-background,#2d2d2d)",
      "font-weight:600",
      "white-space:nowrap",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "display:flex",
      "align-items:center",
      "gap:6px",
    ].join(";");
    const fileName = path.split(/[\\/]/).pop() ?? path;
    const fileLabel = document.createElement("span");
    fileLabel.textContent = fileName;
    fileHeader.appendChild(fileLabel);
    const fileRel = document.createElement("span");
    const rel = path
      .replace(/\\/g, "/")
      .replace(rootPath(), "")
      .replace(/^\/+/, "");
    fileRel.textContent = rel && rel !== fileName ? rel : "";
    fileRel.style.cssText = "color:var(--vscode-descriptionForeground,#888);font-weight:400;font-size:11px;";
    fileHeader.appendChild(fileRel);
    const count = document.createElement("span");
    count.textContent = `${locs.length}`;
    count.style.cssText = [
      "margin-left:auto",
      "background:var(--vscode-badge-background,#4d4d4d)",
      "color:var(--vscode-badge-foreground,#ffffff)",
      "border-radius:8px",
      "padding:1px 7px",
      "font-size:10px",
      "font-weight:600",
    ].join(";");
    fileHeader.appendChild(count);
    group.appendChild(fileHeader);

    for (const loc of locs) {
      const row = document.createElement("div");
      row.className = "locus-refs-row";
      row.title = `${path}:${loc.range.startLineNumber}:${loc.range.startColumn}`;
      row.style.cssText = [
        "padding:2px 10px 2px 28px",
        "cursor:pointer",
        "color:var(--vscode-editorWidget-foreground,#cccccc)",
        "display:flex",
        "align-items:baseline",
        "gap:8px",
        "user-select:none",
      ].join(";");
      const lineLabel = document.createElement("span");
      lineLabel.textContent = `L${loc.range.startLineNumber}:${loc.range.startColumn}`;
      lineLabel.style.cssText = [
        "color:var(--vscode-editorLineNumber-foreground,#858585)",
        "font-variant-numeric:tabular-nums",
        "min-width:48px",
        "text-align:right",
        "flex-shrink:0",
      ].join(";");
      row.appendChild(lineLabel);
      const preview = document.createElement("span");
      preview.textContent = previewLineFor(loc);
      preview.style.cssText = [
        "overflow:hidden",
        "text-overflow:ellipsis",
        "white-space:nowrap",
        "flex:1 1 auto",
        "color:var(--vscode-editorWidget-foreground,#cccccc)",
      ].join(";");
      row.appendChild(preview);
      const onHover = () => { row.style.background = "var(--vscode-list-hoverBackground,#2a2d2e)"; };
      const onLeave = () => { row.style.background = ""; };
      row.addEventListener("mouseenter", onHover);
      row.addEventListener("mouseleave", onLeave);
      row.addEventListener("click", () => { navigateTo(loc); cleanup(); });
      group.appendChild(row);
    }
    body.appendChild(group);
  }

  // ── Footer: hint about keyboard nav (small, dim) ─────────────
  const footer = document.createElement("div");
  footer.style.cssText = [
    "padding:4px 10px",
    "border-top:1px solid var(--vscode-editorWidget-border,#454545)",
    "background:var(--vscode-editorWidget-header-background,#2d2d2d)",
    "color:var(--vscode-descriptionForeground,#888)",
    "font-size:11px",
    "flex-shrink:0",
  ].join(";");
  footer.textContent = "Click to navigate · Esc to dismiss";
  overlay.appendChild(footer);

  // ── Position: cursor-line, viewport coords ─────────────────────
  let top = 80;
  let left = 80;
  try {
    const editorCoords = editor.getScrolledVisiblePosition(originPos);
    if (editorCoords) {
      const editorRect = editor.getContainerDomNode?.()?.getBoundingClientRect();
      if (editorRect) {
        top = editorRect.top + editorCoords.top + editorCoords.height + 4;
        left = editorRect.left + editorCoords.left;
      }
    }
  } catch {
    // fallback top/left is fine
  }
  // Keep the overlay inside the viewport — anchor right side if it
  // would overflow, and never let it clip out the top edge.
  const overlayWidth = 460;
  const maxLeft = window.innerWidth - overlayWidth - 16;
  if (left > maxLeft) left = Math.max(16, maxLeft);
  overlay.style.top = `${Math.max(top, 16)}px`;
  overlay.style.left = `${Math.max(left, 16)}px`;
  document.body.appendChild(overlay);
  refDiag("debug", `rendered overlay at top=${overlay.style.top} left=${overlay.style.left} groups=${sortedGroups.length} rows=${locations.length} sourceId=${sourceId}`);

  // ── Esc + outside-click dismiss ────────────────────────────────
  function cleanup() {
    overlay.remove();
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function dismiss(ev: MouseEvent) {
    if (!overlay.contains(ev.target as Node)) cleanup();
  }
  function onKey(ev: KeyboardEvent) {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      cleanup();
    }
  }
  setTimeout(() => {
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);

  // Pulls a single-line preview from the editor model that owns the
  // reference's URI. We try the in-memory model first (cheap, no
  // IPC) and fall back to a disk read if the file isn't open. The
  // preview is best-effort: a missing file just shows the location.
  function previewLineFor(loc: { uri: monaco.Uri; range: monaco.IRange }): string {
    try {
      const m = monaco.editor.getModel(loc.uri);
      if (m) {
        const text = m.getLineContent(loc.range.startLineNumber).trim();
        if (text) return truncate(text, 60);
      }
    } catch {
      // ignore
    }
    // Fallback: a static stub so the row still shows something useful.
    return truncate(loc.uri.fsPath.replace(/.*[\\/]/, ""), 60);
  }
  function rootPath(): string {
    return props.workingDir.replace(/\\/g, "/").replace(/\/+$/, "");
  }
  function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }
}

function disposeAllMonacoRegistrations() {
  monacoProviderDisposables.forEach((d) => d.dispose());
  monacoProviderDisposables = [];
}

function syncModel() {
  if (!editor) return;
  const file = editorStore.active;
  if (file) {
    if (editor.getModel() !== file.model) {
      // MinimapTokensColorTracker reads the color-map synchronously inside
      // the ViewModel constructor called by setModel.  Ensure the registry
      // has a complete color-map before attaching the model.
      ensureColorMapReady();
      try {
        editor.setModel(file.model);
      } catch (e) {
        console.warn("[editor] setModel failed, retrying once:", e);
        ensureColorMapReady();
        try { editor.setModel(file.model); } catch {}
      }
    }
    editor.updateOptions({ readOnly: !!file.readOnly });
  } else {
    editor.setModel(null);
    editor.updateOptions({ readOnly: false });
  }
  refreshEnclosingContext();
  refreshPreprocessorDimming();
}

function applyTheme() {
  // The standalone theme service + background CSS fallback (installed
  // inside ensureVisualTheme) handle editor coloring. We skip
  // applyVscodeColorTheme here because it writes a workbench theme name
  // to config that the standalone service can't resolve — and any
  // reactive listener trying setTheme("Default Dark Modern") would
  // switch the editor to the "vs" LIGHT fallback, breaking the color
  // map. See the comment in ensureMonacoVscodeServices.
  ensureVisualTheme();
}

function currentFile(): OpenFile | null {
  return editorStore.active;
}

function refreshEnclosingContext() {
  if (!editor || !hasFunctionCtx || !hasClassCtx) return;
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) {
    hasFunctionCtx.set(false);
    hasClassCtx.set(false);
    return;
  }
  const found = findEnclosing(model, position);
  hasFunctionCtx.set(!!found.function);
  hasClassCtx.set(!!found.class);
}

/** Apply dimmed styling to inactive preprocessor branches (#if with undefined symbols). */
function refreshPreprocessorDimming() {
  if (!editor || !preprocessorDecorations) return;
  // Don't dim until we have actual symbol data from the backend.
  // cachedSymbols being empty (not null) means "loaded but empty" — that's fine
  // and we should still apply dimming with an empty set.
  if (cachedSymbols === null) return;
  const model = editor.getModel();
  if (!model) {
    preprocessorDecorations.set([]);
    return;
  }
  const source = model.getValue();
  const ranges = findInactiveRangesFromSource(source, cachedSymbols);
  if (ranges.length === 0) {
    preprocessorDecorations.set([]);
    return;
  }
  preprocessorDecorations.set(
    ranges.map((r) => ({
      range: {
        startLineNumber: r.startLine,
        startColumn: 1,
        endLineNumber: r.endLine,
        endColumn: model.getLineMaxColumn(r.endLine),
      },
      options: {
        isWholeLine: true,
        className: "preprocessor-inactive",
        glyphMarginClassName: undefined,
        inlineClassName: "preprocessor-inactive-inline",
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })),
  );
}

/**
 * Fetch preprocessor symbols for the active file and refresh dimming.
 *
 * Two paths, in order of preference:
 *
 *   1. **Roslyn completion** (`getPreprocessorSymbolsFromCompletion`):
 *      asks the running Roslyn LSP server for `textDocument/completion`
 *      at a `#if` / `#elif` / `#define` line in the file. The completion
 *      provider's preprocessor context returns the full symbol table —
 *      MSBuild-evaluated `<DefineConstants>` (so `[Condition]` and
 *      `$(Variable)` resolve correctly) plus every source-level `#define`
 *      seen so far in the file — in a single RPC. Falls through to the
 *      csproj path if the bridge call rejects (server still warming up,
 *      project not loaded, file too large, etc.).
 *
 *   2. **Owning-csproj regex** (`getPreprocessorSymbols`): reads
 *      `<DefineConstants>` directly from the .csproj that owns the active
 *      file. Misses conditional defines and source-level `#define`, but
 *      doesn't need the Roslyn server. Always succeeds when a csproj
 *      claims the file.
 *
 * On full failure (both paths reject — should be very rare) we set
 * `cachedSymbols` to an empty set so dimming is a no-op rather than
 * crashing.
 */
async function refreshSymbols() {
  const active = currentFile();
  const fileRelPath = active?.relPath;
  const startedAt = performance.now();
  console.log(
    `[preprocessorDimming] refreshSymbols start, fileRelPath=${fileRelPath ?? "<none>"}`,
  );

  // ── Path 1: Roslyn completion (preferred) ──────────────────────────
  if (fileRelPath) {
    try {
      const symbols = await getPreprocessorSymbolsFromCompletion(fileRelPath);
      const elapsed = (performance.now() - startedAt).toFixed(1);
      console.log(
        `[preprocessorDimming] Roslyn probe OK in ${elapsed}ms, ${symbols.length} symbol(s):`,
        symbols,
      );
      cachedSymbols = new Set(symbols);
      refreshPreprocessorDimming();
      return;
    } catch (e) {
      const elapsed = (performance.now() - startedAt).toFixed(1);
      console.warn(
        `[preprocessorDimming] Roslyn probe FAILED in ${elapsed}ms for ${fileRelPath} — falling back to csproj path:`,
        e,
      );
      // fall through to path 2
    }
  } else {
    console.log(
      "[preprocessorDimming] no active file, skipping Roslyn probe",
    );
  }

  // ── Path 2: Owning-csproj regex (fallback) ──────────────────────────
  try {
    const symbols = await getPreprocessorSymbols(fileRelPath);
    const elapsed = (performance.now() - startedAt).toFixed(1);
    console.log(
      `[preprocessorDimming] csproj fallback OK in ${elapsed}ms, ${symbols.length} symbol(s):`,
      symbols,
    );
    cachedSymbols = new Set(symbols);
    refreshPreprocessorDimming();
  } catch (e) {
    const elapsed = (performance.now() - startedAt).toFixed(1);
    console.error(
      `[preprocessorDimming] both paths failed in ${elapsed}ms; dimming disabled for this refresh:`,
      e,
    );
    cachedSymbols = new Set();
    refreshPreprocessorDimming();
  }
}

function lineExcerpt(file: OpenFile, startLine: number, endLine: number): string {
  const model = file.model;
  const last = model.getLineCount();
  const a = Math.max(1, Math.min(startLine, last));
  const b = Math.max(a, Math.min(endLine, last));
  return model.getValueInRange({
    startLineNumber: a,
    startColumn: 1,
    endLineNumber: b,
    endColumn: model.getLineMaxColumn(b),
  });
}

function buildCodeRef(kind: CodeRefKind): CodeRefAttachment | null {
  const file = currentFile();
  if (!editor || !file) return null;
  const model = editor.getModel();
  if (!model) return null;

  if (kind === "selection") {
    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) return null;
    const excerpt = model.getValueInRange(selection);
    return {
      relPath: file.relPath,
      kind: "selection",
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
      startColumn: selection.startColumn,
      endColumn: selection.endColumn,
      language: file.language,
      excerpt,
    };
  }

  if (kind === "line") {
    const position = editor.getPosition();
    if (!position) return null;
    const line = position.lineNumber;
    return {
      relPath: file.relPath,
      kind: "line",
      startLine: line,
      endLine: line,
      startColumn: 1,
      endColumn: model.getLineMaxColumn(line),
      language: file.language,
      excerpt: model.getLineContent(line),
    };
  }

  if (kind === "file") {
    const last = model.getLineCount();
    return {
      relPath: file.relPath,
      kind: "file",
      startLine: 1,
      endLine: last,
      language: file.language,
      excerpt: model.getValue(),
    };
  }

  // function | class
  const position = editor.getPosition();
  if (!position) return null;
  const found = findEnclosing(model, position);
  const symbol: EnclosingSymbol | undefined =
    kind === "function" ? found.function : found.class;
  if (!symbol) return null;
  return {
    relPath: file.relPath,
    kind,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    symbolName: symbol.name,
    language: file.language,
    excerpt: lineExcerpt(file, symbol.startLine, symbol.endLine),
  };
}

function dispatch(kind: CodeRefKind) {
  const ref = buildCodeRef(kind);
  if (ref) emit("code-ref", ref);
}

function registerCodeRefActions(ed: monaco.editor.IStandaloneCodeEditor) {
  hasFunctionCtx = ed.createContextKey<boolean>("locusEditorHasFunction", false);
  hasClassCtx = ed.createContextKey<boolean>("locusEditorHasClass", false);

  ed.addAction({
    id: "locus.codeRef.selection",
    label: "Add Selection to Chat",
    contextMenuGroupId: "locus.coderef",
    contextMenuOrder: 1,
    precondition: "editorHasSelection",
    run: () => dispatch("selection"),
  });
  ed.addAction({
    id: "locus.codeRef.function",
    label: "Add Enclosing Function to Chat",
    contextMenuGroupId: "locus.coderef",
    contextMenuOrder: 2,
    precondition: "locusEditorHasFunction",
    run: () => dispatch("function"),
  });
  ed.addAction({
    id: "locus.codeRef.class",
    label: "Add Enclosing Class to Chat",
    contextMenuGroupId: "locus.coderef",
    contextMenuOrder: 3,
    precondition: "locusEditorHasClass",
    run: () => dispatch("class"),
  });
  ed.addAction({
    id: "locus.codeRef.line",
    label: "Add Current Line to Chat",
    contextMenuGroupId: "locus.coderef",
    contextMenuOrder: 4,
    run: () => dispatch("line"),
  });
  ed.addAction({
    id: "locus.codeRef.file",
    label: "Add Whole File to Chat",
    contextMenuGroupId: "locus.coderef",
    contextMenuOrder: 5,
    run: () => dispatch("file"),
  });
}

async function ensureCsharpClient(workspaceDir: string): Promise<void> {
  const dir = workspaceDir.trim();
  if (!dir) {
    setOmniStatus("disabled");
    return;
  }
  if (csharpClient && csharpClient.workspaceDir === dir) {
    return;
  }
  if (csharpClientPending) {
    await csharpClientPending;
    if (csharpClient && csharpClient.workspaceDir === dir) {
      return;
    }
  }
  csharpClientPending = (async () => {
    disposeAllMonacoRegistrations();
    csharpStatusUnlisten?.();

    if (csharpClient) {
      const old = csharpClient;
      csharpClient = null;
      setOmniStatus("disabled");
      await old.stop().catch(() => {});
    }

    setOmniStatus("connecting", "Starting Roslyn...");
    setOmniName("Roslyn");

    // Every Monaco provider we register below routes through this single
    // bridge to the Rust csharp_lsp backend. The backend owns the Roslyn
    // process; the frontend just forwards JSON-RPC `method` + `params`.
    const lspRequest = (method: string, params: unknown): Promise<unknown> => {
      return csharpLspBridgeRequest(method, params).catch((err) => {
        console.warn(`[lspRequest] ${method} failed:`, err);
        throw err;
      });
    };

    // ── Code Lens (placeholder, exclusive) ────────────────────────────
    // Roslyn does not emit textDocument/codeLens, but Monaco still needs a
    // registered provider to silence the "missing provider" warning. The
    // real "5 references" link is driven by the reference provider below.
    {
      type _CodeLensProvider = Parameters<typeof monaco.languages.registerCodeLensProvider>[1];
      const codeLensEmitter = new monaco.Emitter<_CodeLensProvider>();
      const codeLensProvider: _CodeLensProvider = {
        onDidChange: codeLensEmitter.event,
        provideCodeLenses: async () => ({ lenses: [] }),
        resolveCodeLens: async (_model, codeLens) => codeLens,
      };
      monacoProviderDisposables.push(
        monaco.languages.registerCodeLensProvider(
          { language: "csharp", exclusive: true },
          codeLensProvider,
        ),
        { dispose: () => codeLensEmitter.dispose() },
      );
    }

    // ── Hover ──
    {
      type _HoverProvider = Parameters<typeof monaco.languages.registerHoverProvider>[1];
      const hoverProvider: _HoverProvider = {
        provideHover: async (model, position) => {
          try {
            const result: any = await lspRequest("textDocument/hover", {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            });
            if (!result?.contents) return null;
            const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
            if (contents.length === 0) return null;
            return {
              range: result.range ? lspRangeToMonaco(result.range) : undefined,
              contents: contents.map((c: unknown) => {
                if (typeof c === "string") return { value: c };
                if (typeof c === "object" && c !== null) {
                  const markup = c as { kind?: string; value?: string };
                  return { value: markup.value ?? JSON.stringify(markup) };
                }
                return { value: String(c) };
              }),
            };
          } catch {
            return null;
          }
        },
      };
      monacoProviderDisposables.push(
        monaco.languages.registerHoverProvider(
          { language: "csharp", exclusive: true },
          hoverProvider,
        ),
      );
    }

    // ── Goto-style providers (definition / typeDefinition / implementation) ──
    // Each handler queries Roslyn, then opens the target file via the
    // editor store and positions the cursor. $metadata$ targets are
    // decompiled on demand.
    function registerGotoProvider(
      tag: string,
      lspMethod: string,
      methodKey: string,
      registerFn: (selector: monaco.languages.LanguageSelector, provider: any) => monaco.IDisposable,
    ) {
      const handler = async (
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        token: monaco.CancellationToken,
      ) => {
        let cancelHandle: { dispose(): void } | null = null;
        const cancelPromise = new Promise<never>((_, reject) => {
          cancelHandle = token.onCancellationRequested(() => reject(new Error("cancelled")));
        });
        const cleanup = () => { cancelHandle?.dispose(); cancelHandle = null; };

        const uri = model.uri.toString();
        const pos = `${position.lineNumber}:${position.column}`;
        try {
          const result: any = await Promise.race([
            lspRequest(lspMethod, {
              textDocument: { uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            }),
            cancelPromise,
          ]);
          if (!result) {
            console.log(`[goto/${tag}] ${pos} LSP returned empty`);
            return null;
          }
          const items = Array.isArray(result) ? result : [result];
          console.log(`[goto/${tag}] ${pos} LSP returned ${items.length} result(s)`);
          if (items.length === 0) {
            console.log(`[goto/${tag}] ${pos} LSP returned empty array`);
            return null;
          }
          let loc: { uri: string; range: any } | null = null;
          for (const item of items) {
            const rng = item.targetRange ?? item.range;
            if (rng && (item.uri || item.targetUri)) {
              loc = { uri: item.targetUri ?? item.uri, range: rng };
              break;
            }
          }
          if (!loc) {
            const sample = items[0] ? JSON.stringify(Object.keys(items[0])) : "empty";
            console.log(`[goto/${tag}] ${pos} no valid loc in LSP result (keys=${sample})`);
            return null;
          }
          console.log(`[goto/${tag}] ${pos} target=${loc.uri} range=${JSON.stringify(loc.range)}`);
          const targetUri = monaco.Uri.parse(loc.uri);
          const targetRange = lspRangeToMonaco(loc.range);
          const uriPath = targetUri.fsPath.replace(/\\/g, "/");
          const root = props.workingDir.replace(/\\/g, "/").replace(/\/+$/, "");

          if (uriPath.includes("$metadata$")) {
            console.log(`[goto/${tag}] ${pos} metadata decompile: ${uriPath}`);
            if (token.isCancellationRequested) return null;
            try {
              let m = monaco.editor.getModel(targetUri);
              if (!m) {
                const metaPath = targetUri.path.replace(/^\//, "");
                const source = await Promise.race([
                  ipcInvoke<string>("decompile_metadata", {
                    metadataPath: metaPath,
                    workspaceDir: props.workingDir,
                  }),
                  cancelPromise,
                ]);
                m = monaco.editor.createModel(source, "csharp", targetUri);
              }
              if (m) {
                const filename = targetUri.path.split("/").pop() ?? targetUri.fsPath;
                editorStore.openVirtualFile(targetUri.toString(), filename, m);
                syncModel();
                if (editor) {
                  editor.setPosition({ lineNumber: targetRange.startLineNumber, column: targetRange.startColumn });
                  editor.revealPositionInCenter({ lineNumber: targetRange.startLineNumber, column: targetRange.startColumn });
                  editor.focus();
                }
              }
            } catch (metaErr: any) {
              if (metaErr?.message !== "cancelled")
                console.warn(`[${tag}] metadata navigation failed:`, metaErr);
            }
            return null;
          }

          if (uriPath.toLowerCase().startsWith(root.toLowerCase())) {
            const relPath = uriPath.slice(root.length + 1);
            try {
              const opened = await editorStore.openFile(relPath);
              if (editor && opened) {
                editor.setPosition({ lineNumber: targetRange.startLineNumber, column: targetRange.startColumn });
                editor.revealPositionInCenter({ lineNumber: targetRange.startLineNumber, column: targetRange.startColumn });
                editor.focus();
              } else {
                console.log(`[goto/${tag}] ${pos} openFile returned ${!!opened} for ${relPath}`);
              }
            } catch (navErr) {
              console.warn(`[goto/${tag}] ${pos} openFile failed for ${relPath}:`, navErr);
            }
          } else {
            console.log(`[goto/${tag}] ${pos} outside workspace: ${uriPath}`);
          }
          return [{ uri: targetUri, range: targetRange }];
        } catch (err: any) {
          if (err?.message !== "cancelled") console.warn(`[goto/${tag}] ${pos} LSP request failed:`, err);
          else console.log(`[goto/${tag}] ${pos} cancelled`);
          return null;
        } finally {
          cleanup();
        }
      };
      monacoProviderDisposables.push(
        registerFn({ language: "csharp", exclusive: true }, { [methodKey]: handler }),
      );
    }
    registerGotoProvider("definition", "textDocument/definition", "provideDefinition", monaco.languages.registerDefinitionProvider);
    registerGotoProvider("typeDefinition", "textDocument/typeDefinition", "provideTypeDefinition", monaco.languages.registerTypeDefinitionProvider);
    registerGotoProvider("implementation", "textDocument/implementation", "provideImplementation", monaco.languages.registerImplementationProvider);

    // ── References ──
    {
      const refHandler = async (
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        context: monaco.languages.ReferenceContext,
      ) => {
        try {
          const result: any = await lspRequest("textDocument/references", {
            textDocument: { uri: model.uri.toString() },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            context: { includeDeclaration: context.includeDeclaration },
          });
          if (!Array.isArray(result)) return [];
          return result.map((r: any) => ({
            uri: monaco.Uri.parse(r.uri),
            range: lspRangeToMonaco(r.range),
          }));
        } catch (err) {
          console.warn(`[refProvider] LSP request failed:`, err);
          return [];
        }
      };
      monacoProviderDisposables.push(
        monaco.languages.registerReferenceProvider(
          { language: "csharp", exclusive: true },
          { provideReferences: refHandler },
        ),
      );
    }

    // ── Override Monaco's built-in reference commands (Shift+F12 / right-click) ──
    // Monaco's CommandsRegistry handles these before vscode.commands fires;
    // we replace the registered commands so peek references go through Roslyn.
    for (const id of [
      "editor.action.findReferences",
      "editor.action.goToReferences",
      "editor.action.referenceSearch.trigger",
    ]) {
      CommandsRegistry.registerCommand(id, (_accessor: any, resource?: monaco.Uri, position?: monaco.Position) => {
        (async () => {
          const effectiveResource = resource ?? editor?.getModel()?.uri;
          const effectivePosition = position ?? editor?.getPosition() ?? undefined;
          if (!effectiveResource || !effectivePosition) return;
          try {
            const refs: any = await lspRequest("textDocument/references", {
              textDocument: { uri: effectiveResource.toString() },
              position: {
                line: effectivePosition.lineNumber - 1,
                character: effectivePosition.column - 1,
              },
              context: { includeDeclaration: false },
            });
            if (!Array.isArray(refs) || refs.length === 0) {
              refDiag("warn", "LSP textDocument/references returned empty or non-array — Shift+F12 will appear to do nothing", {
                sourceId: id,
                isArray: Array.isArray(refs),
                length: Array.isArray(refs) ? refs.length : "n/a",
                sample: Array.isArray(refs) && refs[0] ? JSON.stringify(refs[0]).slice(0, 200) : "n/a",
                uri: effectiveResource.toString(),
                pos: `${effectivePosition.lineNumber}:${effectivePosition.column}`,
              });
              return;
            }
            const locations = refs.map((r: any) => ({
              uri: monaco.Uri.parse(r.uri),
              range: lspRangeToMonaco(r.range),
            }));
            const vscode = await import("vscode");
            try {
              await vscode.commands.executeCommand(
                "editor.action.showReferences",
                effectiveResource,
                effectivePosition,
                locations,
                "peek",
              );
            } catch (cmdErr) {
              // vscode API not ready in monaco-vscode-api 33.0.9's
              // extension host (a known race: localExtensionHost worker
              // may not have published the default API by the time the
              // user fires Shift+F12). Fall back to a custom DOM widget
              // so the user still gets usable feedback. Warn once per
              // session, then quietly use the fallback — see the
              // `showReferencesApiBroken` flag above.
              if (!showReferencesApiBroken) {
                showReferencesApiBroken = true;
                console.warn(
                  `[refCmd] showReferences unavailable in monaco-vscode-api 33.0.9 ` +
                  `(extension host race). Using the custom references widget ` +
                  `for this and all subsequent calls in this session:`,
                  cmdErr,
                );
              } else {
                console.debug(`[refCmd] showReferences unavailable, using fallback:`, cmdErr);
              }
              showReferencesFallback(effectiveResource, effectivePosition, locations, id);
            }
          } catch (err) {
            console.warn(`[refCmd] ${id} failed:`, err);
          }
        })();
      });
    }

    // ── Metadata fetcher for $metadata$ files (Unity/framework types) ──
    fsProvider.setMetadataFetcher(async (uriStr: string) => {
      const metaUri = monaco.Uri.parse(uriStr);
      const metadataPath = metaUri.path.replace(/^\//, "");
      return await ipcInvoke<string>("decompile_metadata", {
        metadataPath,
        workspaceDir: props.workingDir,
      });
    });

    // ── Subscribe to Roslyn status events (phase / projectCount / serverVersion) ──
    // The backend pushes these whenever the csharp_lsp module transitions
    // phases (preparing → starting → loading → ready → error). We mirror
    // them into the status composable that drives the status bar dot.
    csharpStatusUnlisten = await subscribeCsharpLspStatus((status: any) => {
      const phase = status?.phase;
      const projectCount = status?.projectCount ?? 0;
      const serverVersion = status?.serverVersion ?? "";
      const projectFile = status?.projectFile ?? "";
      const error = status?.error;
      if (phase === "ready") {
        const detail = projectFile
          ? `${projectFile} · ${projectCount}p · ${serverVersion || "roslyn"}`
          : "Ready";
        setOmniStatus("ready", detail);
      } else if (phase === "starting" || phase === "loading" || phase === "preparing") {
        setOmniStatus("connecting", `Loading (${projectCount} projects)`);
      } else if (phase === "error" || error) {
        setOmniStatus("error", error ?? "Roslyn error");
      } else {
        setOmniStatus("initializing", phase ?? "Initializing");
      }
    });

    // Seed initial status so the dot reflects reality even if no event
    // has fired yet (e.g. backend started before the editor mounted).
    try {
      const initial = await csharpLspGetStatus();
      if (initial?.phase === "ready") {
        const detail = initial.projectFile
          ? `${initial.projectFile} · ${initial.projectCount}p · ${initial.serverVersion || "roslyn"}`
          : "Ready";
        setOmniStatus("ready", detail);
      } else if (initial?.phase) {
        setOmniStatus("initializing", initial.phase);
      }
    } catch (e) {
      console.warn("[csharpLsp] getStatus failed:", e);
    }

    // Sentinel: re-entry guard for the next ensureCsharpClient call. There
    // is no frontend-owned Roslyn process; the Rust backend owns it.
    csharpClient = {
      workspaceDir: dir,
      stop: async () => {
        csharpClient = null;
      },
    };
  })();
  try {
    await csharpClientPending;
  } finally {
    csharpClientPending = null;
  }
}

async function disposeCsharpClient(): Promise<void> {
  // Clean up custom provider registrations first
  disposeAllMonacoRegistrations();
  csharpStatusUnlisten?.();
  csharpStatusUnlisten = null;

  if (csharpClientPending) {
    await csharpClientPending.catch(() => {});
    csharpClientPending = null;
  }
  if (csharpClient) {
    const c = csharpClient;
    csharpClient = null;
    await c.stop().catch(() => {});
  }
  setOmniStatus("disabled");
}

onMounted(async () => {
  if (!container.value) return;

  await ensureMonacoVscodeServices();

  // 告诉文件系统 provider workspace 根目录，这样未打开的文件也能从磁盘读取
  setFsRoot(props.workingDir);

  applyTheme();

  editor = monaco.editor.create(container.value, {
    model: null,
    automaticLayout: false,
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderWhitespace: "selection",
    smoothScrolling: true,
    tabSize: 2,
    wordWrap: "off",
  });

  registerCodeRefActions(editor);
  cursorListener = editor.onDidChangeCursorPosition(() => refreshEnclosingContext());

  // Preprocessor inactive-range dimming
  preprocessorDecorations = editor.createDecorationsCollection();
  dimModelListener = editor.onDidChangeModelContent(() => refreshPreprocessorDimming());
  dimCursorListener = editor.onDidChangeCursorPosition(() => refreshPreprocessorDimming());

  // Wire up the Roslyn textDocument/didOpen / didChange / didClose
  // bridge for any csharp model that already exists or that gets
  // created later (e.g. via editorStore.openFile). The EditorSync
  // service attaches the onDidChangeContent and onWillDispose
  // listeners itself.
  monaco.editor.onDidCreateModel((model) => trackModel(model));
  trackAllCurrentModels(() => monaco.editor.getModels());

  // Force the color map to be complete before attaching the first model
  // (MinimapTokensColorTracker reads it synchronously in the constructor).
  ensureColorMapReady();
  syncModel();

  resizeHandle = createAnimationFrameResizeObserver(() => {
    editor?.layout();
  });
  if (resizeHandle && container.value) {
    resizeHandle.observe(container.value);
  }

  themeObserver = new MutationObserver(() => applyTheme());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  if (props.workingDir.trim()) {
    console.log(`[onMounted] calling ensureCsharpClient with "${props.workingDir}"`);
    void ensureCsharpClient(props.workingDir).then(() => void refreshSymbols());
  }
});

watch(() => editorStore.active, syncModel);

// Re-fetch preprocessor symbols whenever the active file changes — the
// defines we need for `#if` dimming are per-csproj, and each file belongs
// to a different one. syncModel above swaps the editor's model first; this
// watch fires after it and refreshes the dimming with the new file's
// owning-csproj defines.
watch(
  () => editorStore.active?.relPath,
  () => {
    void refreshSymbols();
  },
);

watch(
  () => props.workingDir,
  async (next) => {
    if (next.trim()) {
      await ensureCsharpClient(next);
      void refreshSymbols();
    } else {
      void disposeCsharpClient();
    }
  },
);

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  themeObserver = null;
  resizeHandle?.disconnect();
  resizeHandle = null;
  cursorListener?.dispose();
  cursorListener = null;
  dimModelListener?.dispose();
  dimCursorListener?.dispose();
  preprocessorDecorations?.clear();
  preprocessorDecorations = null;
  cachedSymbols = null;
  hasFunctionCtx = null;
  hasClassCtx = null;
  // Detach model before disposing so we don't dispose models the store still owns.
  editor?.setModel(null);
  editor?.dispose();
  editor = null;
  // Dispose all Monaco provider registrations (hover, codeLens, completion, etc.)
  // to prevent accumulation across LSP client restarts.
  disposeAllMonacoRegistrations();
  resetEditorSync();
  void disposeCsharpClient();
});

defineExpose({
  focus: () => editor?.focus(),
});
</script>

<template>
  <div ref="container" class="monaco-host" />
</template>

<style scoped>
.monaco-host {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
