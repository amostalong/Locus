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
// stable on first use; we fall back to F12-style "navigate to first reference"
// rather than rendering a custom peek widget (which would diverge from F12's
// UI shape — see `navigateToLocation`). Warn once, debug thereafter, so the
// console isn't spammed.
let showReferencesApiBroken = false;

// Diagnostic flag for the references flow. Several silent-bail cases
// are still possible (LSP returns empty array, editor is null mid-flow,
// openFile returns falsy and cursor lands on the OLD model). Each of
// these now logs at least once via the [refDiag] tag so we can pinpoint
// which one is biting. Same warn-once-then-debug pattern as
// `showReferencesApiBroken`.
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
 * Navigate the editor to a single LSP location, mirroring what F12 does.
 * In-workspace targets switch tabs via `editorStore.openFile` and place
 * the cursor; out-of-workspace targets (e.g. `$metadata$` decompilations
 * that live in `%TEMP%`) open a read-only virtual tab.
 *
 * Used by the references command as the fall-through for the
 * monaco-vscode-api 33.0.9 "Default api is not ready" race on
 * `editor.action.showReferences` — instead of opening a peek widget
 * (which would be a different UI shape than F12), we go straight to
 * the first location, matching F12's "press → cursor moves" behavior.
 */
async function navigateToLocation(
  loc: { uri: monaco.Uri; range: monaco.IRange },
): Promise<void> {
  if (!editor) {
    refDiag("warn", "navigateToLocation called with no editor", { uri: loc.uri.fsPath });
    return;
  }
  const root = props.workingDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = loc.uri.fsPath.replace(/\\/g, "/");
  if (target.toLowerCase().startsWith(root.toLowerCase())) {
    const rel = target.slice(root.length + 1);
    try {
      const opened = await editorStore.openFile(rel);
      refDiag("debug", `navigateToLocation openFile rel=${rel} opened=${!!opened}`);
      if (!opened) {
        refDiag("warn", "navigateToLocation openFile returned falsy — setPosition will land on the OLD model", { rel });
        return;
      }
      editor.setPosition({ lineNumber: loc.range.startLineNumber, column: loc.range.startColumn });
      editor.revealPositionInCenter({ lineNumber: loc.range.startLineNumber, column: loc.range.startColumn });
      editor.focus();
    } catch (e) {
      console.warn("[refCmd] openFile failed:", e);
    }
  } else {
    // Reference points outside the workspace (e.g. a Roslyn
    // decompilation in %TEMP%). Open as a read-only virtual tab.
    let m = monaco.editor.getModel(loc.uri);
    if (!m) m = monaco.editor.createModel("", "csharp", loc.uri);
    const fileName = loc.uri.path.split("/").pop() ?? loc.uri.fsPath;
    editorStore.openVirtualFile(loc.uri.toString(), fileName, m);
    editor.setPosition({ lineNumber: loc.range.startLineNumber, column: loc.range.startColumn });
    editor.revealPositionInCenter({ lineNumber: loc.range.startLineNumber, column: loc.range.startColumn });
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
              // user fires Shift+F12). The native peek view would be the
              // "right" rendering here, but we deliberately do not open
              // a custom widget — that would diverge from F12's UI shape.
              // Instead, navigate to the first reference just like F12
              // would. Warn once per session, then quietly do this.
              if (!showReferencesApiBroken) {
                showReferencesApiBroken = true;
                console.warn(
                  `[refCmd] showReferences unavailable in monaco-vscode-api 33.0.9 ` +
                  `(extension host race). Navigating to the first reference ` +
                  `as a fallback for this and all subsequent calls in this session:`,
                  cmdErr,
                );
              } else {
                console.debug(`[refCmd] showReferences unavailable, navigating to first:`, cmdErr);
              }
              refDiag("debug", `fallback navigation total=${locations.length} first=${locations[0]?.uri.fsPath}:${locations[0]?.range.startLineNumber}:${locations[0]?.range.startColumn}`);
              await navigateToLocation(locations[0]);
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
