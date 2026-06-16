<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from "monaco-editor";

import { useEditorStore, type OpenFile } from "../../stores/editor";
import { createAnimationFrameResizeObserver } from "../../composables/resizeObserver";
import {
  applyVscodeColorTheme,
  ensureMonacoVscodeServices,
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

// ── Monaco Provider Registration Tracking ─────────────────────────────
// Store ALL Monaco provider registration disposables so we can clean them
// up on component unmount. This prevents provider accumulation (and
// duplicate code lens / completion results) across LSP client restarts.
//
// Pattern: register → store disposable → dispose on unmount.
// See: https://github.com/microsoft/monaco-editor/issues/xxx
let monacoProviderDisposables: monaco.IDisposable[] = [];

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

function disposeAllMonacoRegistrations() {
  monacoProviderDisposables.forEach((d) => d.dispose());
  monacoProviderDisposables = [];
}

function syncModel() {
  if (!editor) return;
  const file = editorStore.active;
  if (file) {
    if (editor.getModel() !== file.model) {
      editor.setModel(file.model);
    }
    editor.updateOptions({ readOnly: !!file.readOnly });
  } else {
    editor.setModel(null);
    editor.updateOptions({ readOnly: false });
  }
  refreshEnclosingContext();
}

function applyTheme() {
  void applyVscodeColorTheme();
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
        try {
          const result: any = await Promise.race([
            lspRequest(lspMethod, {
              textDocument: { uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            }),
            cancelPromise,
          ]);
          if (!result) return null;
          const items = Array.isArray(result) ? result : [result];
          let loc: { uri: string; range: any } | null = null;
          for (const item of items) {
            const rng = item.targetRange ?? item.range;
            if (rng && (item.uri || item.targetUri)) {
              loc = { uri: item.targetUri ?? item.uri, range: rng };
              break;
            }
          }
          if (!loc) return null;
          const targetUri = monaco.Uri.parse(loc.uri);
          const targetRange = lspRangeToMonaco(loc.range);
          const uriPath = targetUri.fsPath.replace(/\\/g, "/");
          const root = props.workingDir.replace(/\\/g, "/").replace(/\/+$/, "");

          if (uriPath.includes("$metadata$")) {
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
              }
            } catch (navErr) {
              console.warn(`[${tag}] navigation failed:`, navErr);
            }
          }
          return [{ uri: targetUri, range: targetRange }];
        } catch (err: any) {
          if (err?.message !== "cancelled") console.warn(`[${tag}] LSP request failed:`, err);
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
            if (!Array.isArray(refs) || refs.length === 0) return;
            const locations = refs.map((r: any) => ({
              uri: monaco.Uri.parse(r.uri),
              range: lspRangeToMonaco(r.range),
            }));
            const vscode = await import("vscode");
            await vscode.commands.executeCommand(
              "editor.action.showReferences",
              effectiveResource,
              effectivePosition,
              locations,
              "peek",
            );
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
    void ensureCsharpClient(props.workingDir);
  }
});

watch(() => editorStore.active, syncModel);

watch(
  () => props.workingDir,
  (next) => {
    if (next.trim()) {
      void ensureCsharpClient(next);
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
  hasFunctionCtx = null;
  hasClassCtx = null;
  // Detach model before disposing so we don't dispose models the store still owns.
  editor?.setModel(null);
  editor?.dispose();
  editor = null;
  // Dispose all Monaco provider registrations (hover, codeLens, completion, etc.)
  // to prevent accumulation across LSP client restarts.
  disposeAllMonacoRegistrations();
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
