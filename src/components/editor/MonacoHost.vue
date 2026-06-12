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
import {
  startCsharpLanguageClient,
  type LanguageClientHandle,
} from "../../services/lspClient";
import { findEnclosing, type EnclosingSymbol } from "../../services/codeRefDetect";
import { ipcInvoke } from "../../services/ipc";
import { useOmnisharpStatus } from "../../composables/useOmnisharpStatus";
import { StandaloneServices, ILanguageFeaturesService } from "@codingame/monaco-vscode-api/services";
import type { CodeRefAttachment, CodeRefKind } from "../../types";
// 用于覆盖 Monaco 内部的 editor.action.findReferences 命令
// （vscode.commands.registerCommand 走的是 VS Code API 扩展主机桥，覆盖不了）
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";

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
let csharpClient: LanguageClientHandle | null = null;
let csharpClientPending: Promise<void> | null = null;
const { setStatus: setOmniStatus, setName: setOmniName } = useOmnisharpStatus();
let omniReadyUnlisten: (() => void) | null = null;
let omniExitUnlisten: (() => void) | null = null;
let omniReadyTimeout: ReturnType<typeof setTimeout> | null = null;

// ── Monaco Provider Registration Tracking ─────────────────────────────
// Store ALL Monaco provider registration disposables so we can clean them
// up on component unmount. This prevents provider accumulation (and
// duplicate code lens / completion results) across LSP client restarts.
//
// Pattern: register → store disposable → dispose on unmount.
// See: https://github.com/microsoft/monaco-editor/issues/xxx
let monacoProviderDisposables: monaco.IDisposable[] = [];
let lspRequestorCleanup: (() => void) | null = null;

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
  lspRequestorCleanup?.();
  lspRequestorCleanup = null;
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
  console.log(`[ensureCsharpClient] called with dir="${dir}", csharpClient=`, !!csharpClient, 'csharpClientPending=', !!csharpClientPending);
  if (!dir) {
    console.log(`[ensureCsharpClient] dir is empty, disabled`);
    setOmniStatus("disabled");
    return;
  }
  if (csharpClient && csharpClient.workspaceDir === dir) {
    console.log(`[ensureCsharpClient] already have client for ${dir}, skip`);
    return;
  }
  if (csharpClientPending) {
    console.log(`[ensureCsharpClient] awaiting existing pending...`);
    await csharpClientPending;
    if (csharpClient && csharpClient.workspaceDir === dir) {
      console.log(`[ensureCsharpClient] after pending, already have client for ${dir}, skip`);
      return;
    }
  }
  csharpClientPending = (async () => {
    // Clean up old custom provider registrations before starting fresh
    disposeAllMonacoRegistrations();

    // Clean up previous listeners and timeouts before starting fresh
    omniReadyUnlisten?.();
    omniReadyUnlisten = null;
    omniExitUnlisten?.();
    omniExitUnlisten = null;
    if (omniReadyTimeout) {
      clearTimeout(omniReadyTimeout);
      omniReadyTimeout = null;
    }

    if (csharpClient) {
      const old = csharpClient;
      csharpClient = null;
      setOmniStatus("disabled");
      await old.stop().catch((err) => {
        console.warn("[lsp] failed to stop previous C# client:", err);
      });
    }

    setOmniStatus("connecting", "Starting OmniSharp...");
    setOmniName("OmniSharp");
    try {
      // ── Register exclusive code lens provider ────────────────────────
      // Register BEFORE MLC starts so our `exclusive: true` provider is
      // already in the LanguageFeatureRegistry when MLC's CodeLensFeature
      // registers its own provider. The exclusive flag hides MLC's provider
      // (score 0) and only ours is visible (score 1000). Monaco never sees
      // MLC's provider — no "5 refs | 5 refs" from the very first query.
      //
      // The provider returns `{ lenses: [] }` while LSP isn't ready
      // (lspRequest is null). Once the requestor is set up below, we fire
      // onDidChange to trigger Monaco to re-query with real data.
      let lspRequest: ((method: string, params: unknown) => Promise<unknown>) | null = null;
      let clCallCount = 0;
      type _CodeLensProvider = Parameters<typeof monaco.languages.registerCodeLensProvider>[1];
      const codeLensEmitter = new monaco.Emitter<_CodeLensProvider>();
      const codeLensProvider: _CodeLensProvider = {
        onDidChange: codeLensEmitter.event,
        provideCodeLenses: async (model, _token) => {
          clCallCount++;
          const uri = model.uri.toString();
          console.log(`[codeLens] provideCodeLenses called #${clCallCount} for ${uri}, lspRequest=`, !!lspRequest);
          // 检查 registry 状态
          try {
            const svc = StandaloneServices.get(ILanguageFeaturesService);
            const raw = (svc.codeLensProvider as any);
            if (raw._entries) {
              console.log(`[codeLens] registry _entries=${raw._entries.length}`, raw._entries.map((e: any) => ({
                exclusive: e.selector?.exclusive,
                isBuiltin: e.selector?.isBuiltin,
                score: e._score,
                hasData: typeof e.provider?.provideCodeLenses === 'function',
              })));
            }
          } catch (e) {};
          const req = lspRequest;
          if (!req) {
            console.log(`[codeLens] lspRequest not ready yet, returning empty`);
            return { lenses: [] };
          }
          try {
            console.log(`[codeLens] sending textDocument/codeLens for ${uri}`);
            const result = await req("textDocument/codeLens", {
              textDocument: { uri },
            });
            console.log(`[codeLens] LSP result for ${uri}:`, JSON.stringify(result).slice(0, 500));
            if (!Array.isArray(result)) {
              console.log(`[codeLens] result is not array, type=${typeof result}, returning empty`);
              return { lenses: [] };
            }
            console.log(`[codeLens] got ${result.length} lenses`);
            const lenses = result.map((cl: any) => ({
              range: lspRangeToMonaco(cl.range),
              // Preserve LSP `data` field so resolveCodeLens can use it
              data: cl.data,
              command: cl.command
                ? {
                    id: cl.command.command,
                    title: cl.command.title,
                    arguments: cl.command.arguments,
                  }
                : undefined,
            }));
            console.log(`[codeLens] returning ${lenses.length} lenses, first has command=`, !!lenses[0]?.command);
            return { lenses };
          } catch (err) {
            console.log(`[codeLens] LSP request failed:`, err);
            return { lenses: [] };
          }
        },
        resolveCodeLens: async (_model, codeLens, _token) => {
          const req = lspRequest;
          if (!req || !(codeLens as any).data) {
            console.log(`[codeLens] resolveCodeLens: skipped (no req or no data)`);
            return codeLens;
          }
          try {
            console.log(`[codeLens] resolveCodeLens: sending codeLens/resolve`);
            const result = await req("codeLens/resolve", {
              range: {
                start: { line: codeLens.range.startLineNumber - 1, character: codeLens.range.startColumn - 1 },
                end: { line: codeLens.range.endLineNumber - 1, character: codeLens.range.endColumn - 1 },
              },
              data: (codeLens as any).data,
            });
            if (result && (result as any).command) {
              console.log(`[codeLens] resolveCodeLens: resolved, title="${(result as any).command.title}"`);
              return {
                range: codeLens.range,
                data: (result as any).data,
                command: {
                  id: (result as any).command.command,
                  title: (result as any).command.title,
                  arguments: (result as any).command.arguments,
                },
              };
            }
            console.log(`[codeLens] resolveCodeLens: no command in result`);
            return codeLens;
          } catch (err) {
            console.log(`[codeLens] resolveCodeLens failed:`, err);
            return codeLens;
          }
        },
      };
      console.log(`[codeLens] registering exclusive provider for csharp`);
      monacoProviderDisposables.push(
        monaco.languages.registerCodeLensProvider(
          { language: "csharp", exclusive: true },
          codeLensProvider,
        ),
        { dispose: () => codeLensEmitter.dispose() },
      );

      // ── Register exclusive hover provider ──────────────────────────────
      // Same pattern as code lens: register BEFORE MLC starts so our
      // `exclusive: true` provider hides MLC's HoverFeature provider.
      // Returns null while LSP isn't ready (lspRequest is null).
      type _HoverProvider = Parameters<typeof monaco.languages.registerHoverProvider>[1];
      const hoverProvider: _HoverProvider = {
        provideHover: async (model, position, _token) => {
          const req = lspRequest;
          if (!req) return null;
          try {
            const result = await req("textDocument/hover", {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            });
            if (!result) return null;
            const h = result as { contents?: unknown; range?: { start: { line: number; character: number }; end: { line: number; character: number } } };
            if (!h.contents) return null;
            const contents = Array.isArray(h.contents) ? h.contents : [h.contents];
            if (contents.length === 0) return null;
            return {
              range: h.range ? lspRangeToMonaco(h.range) : undefined,
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

      // ── Shared helper: register goto-style providers ─────────────────
      // Monaco standalone 不会自动打开/切 tab，所以每个 goto provider
      // 在返回位置后额外通过 editorStore 打开文件 + 跳转光标。
      // 覆盖 definition / typeDefinition / implementation 三个。
      // 每个 registerXxxProvider 要求 provider 上有对应的方法名
      // （provideDefinition / provideTypeDefinition / provideImplementation），
      // 通过 methodKey 参数指定。
      function registerGotoProvider(
        tag: string,
        lspMethod: string,
        methodKey: string,
        registerFn: (selector: monaco.languages.LanguageSelector, provider: any) => monaco.IDisposable,
      ) {
        const handler = async (model: monaco.editor.ITextModel, position: monaco.Position, token: monaco.CancellationToken) => {
          const req = lspRequest;
          if (!req) return null;

          // Wire Monaco's cancellation token so that moving the cursor or pressing
          // Escape immediately aborts the pending LSP request instead of waiting
          // for the 15 s timeout (especially important while OmniSharp is still
          // analysing the project on startup).
          let cancelHandle: { dispose(): void } | null = null;
          const cancelPromise = new Promise<never>((_, reject) => {
            cancelHandle = token.onCancellationRequested(() =>
              reject(new Error("cancelled")),
            );
          });
          const cleanup = () => { cancelHandle?.dispose(); cancelHandle = null; };

          const uri = model.uri.toString();
          try {
            const t0 = performance.now();
            const result = await Promise.race([
              req(lspMethod, {
                textDocument: { uri },
                position: { line: position.lineNumber - 1, character: position.column - 1 },
              }),
              cancelPromise,
            ]);
            // Note: cleanup() is NOT called here. Keeping cancelHandle alive
            // lets cancelPromise remain active for the inner race in the
            // $metadata$ branch (decompile step), so cancellation works there too.
            console.log(`[${tag}] ${lspMethod} in ${(performance.now() - t0).toFixed(0)}ms`);
            if (!result) return null;
            const items = Array.isArray(result) ? result : [result];
            const loc = (() => {
              for (const item of items) {
                const rng = item.targetRange ?? item.range;
                if (rng && (item.uri || item.targetUri)) {
                  return { uri: item.targetUri ?? item.uri, range: rng };
                }
              }
              return null;
            })();
            if (!loc) return null;
            const targetUri = monaco.Uri.parse(loc.uri);
            const targetRange = lspRangeToMonaco(loc.range);
            console.log(`[${tag}] target: ${targetUri.fsPath} @ L${targetRange.startLineNumber}:${targetRange.startColumn}`);
            const uriPath = targetUri.fsPath.replace(/\\/g, "/");
            const root = props.workingDir.replace(/\\/g, "/").replace(/\/+$/, "");

            // $metadata$ files: open as a read-only tab via the store so the
            // tab bar reflects the navigation, then navigate to the definition line.
            if (uriPath.includes("$metadata$")) {
              if (token.isCancellationRequested) return null;
              try {
                let model = monaco.editor.getModel(targetUri);
                if (!model) {
                  // Model not cached yet — decompile now.
                  const metaPath = targetUri.path.replace(/^\//, "");
                  const source = await Promise.race([
                    ipcInvoke<string>("decompile_metadata", {
                      metadataPath: metaPath,
                      workspaceDir: props.workingDir,
                    }),
                    cancelPromise,
                  ]);
                  model = monaco.editor.createModel(source, "csharp", targetUri);
                }
                if (model) {
                  const filename = targetUri.path.split("/").pop() ?? targetUri.fsPath;
                  editorStore.openVirtualFile(targetUri.toString(), filename, model);
                  // syncModel() is triggered reactively but may be deferred;
                  // call it immediately so the model switch is synchronous before
                  // we set the cursor position below.
                  syncModel();
                  if (editor) {
                    editor.setPosition({ lineNumber: targetRange.startLineNumber, column: targetRange.startColumn });
                    editor.revealPositionInCenter({ lineNumber: targetRange.startLineNumber, column: targetRange.startColumn });
                    editor.focus();
                    console.log(`[${tag}] navigated to metadata: ${targetUri.fsPath}`);
                  }
                }
              } catch (metaErr: any) {
                if (metaErr?.message !== "cancelled")
                  console.warn(`[${tag}] metadata navigation failed:`, metaErr);
              }
              return null; // we handled it; don't hand off to Monaco's editor service
            }

            if (uriPath.toLowerCase().startsWith(root.toLowerCase())) {
              const relPath = uriPath.slice(root.length + 1);
              try {
                const opened = await editorStore.openFile(relPath);
                if (editor && opened) {
                  // readOnly is reset by syncModel() which fires on store.active change.
                  editor.setPosition({ lineNumber: targetRange.startLineNumber, column: targetRange.startColumn });
                  editor.revealPositionInCenter({ lineNumber: targetRange.startLineNumber, column: targetRange.startColumn });
                  editor.focus();
                  console.log(`[${tag}] navigated to ${relPath}`);
                }
              } catch (navErr) { console.warn(`[${tag}] navigation failed:`, navErr); }
            }
            return [{ uri: targetUri, range: targetRange }];
          } catch (err: any) {
            if (err?.message !== "cancelled") console.warn(`[${tag}] LSP request failed:`, err);
            return null;
          } finally {
            // Always release the cancellation listener regardless of exit path
            // (normal return, throw, or early return from $metadata$ branch).
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

      // ── Register exclusive reference provider ─────────────────────────
      // 统一点击 code lens 和右键 Find References 两条路。
      const refHandler = async (model: monaco.editor.ITextModel, position: monaco.Position, context: monaco.languages.ReferenceContext, _token: monaco.CancellationToken) => {
        const req = lspRequest;
        if (!req) return [];
        const uri = model.uri.toString();
        try {
          const t0 = performance.now();
          const result = await req("textDocument/references", {
            textDocument: { uri },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
            context: { includeDeclaration: context.includeDeclaration },
          });
          console.log(`[refProvider] references in ${(performance.now() - t0).toFixed(0)}ms, count=${Array.isArray(result) ? result.length : 0}`);
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

      // ── Start MLC (CodeLensFeature / HoverFeature register their own
      // providers during client.start(), but our exclusive ones already
      // hide them) ──
      csharpClient = await startCsharpLanguageClient(dir);

      // ── Dump registry state for all relevant features ──────────────
      // Check how many providers are registered per feature, their scores
      // and exclusive flags. This helps diagnose duplicate registrations
      // across all LSP features (definition, references, completion, etc.).
      {
        const svc = StandaloneServices.get(ILanguageFeaturesService);
        for (const key of ["definitionProvider", "referenceProvider", "typeDefinitionProvider", "declarationProvider", "implementationProvider", "completionProvider", "signatureHelpProvider", "documentHighlightProvider", "documentSymbolProvider", "codeActionProvider", "renameProvider", "hoverProvider", "codeLensProvider"]) {
          const reg = (svc as any)[key];
          if (reg?._entries) {
            const entries = reg._entries.map((e: any) => ({
              lang: typeof e.selector === 'object' ? e.selector.language ?? e.selector.languageId : e.selector,
              exclusive: !!e.selector?.exclusive,
              isBuiltin: !!e.selector?.isBuiltin,
              score: e._score,
            }));
            const nonZero = entries.filter((e: any) => e.score > 0);
            if (nonZero.length > 1) {
              console.log(`[registry] ${key}: ${entries.length} entries, ${nonZero.length} active:`, JSON.stringify(nonZero));
            } else if (entries.length > 0) {
              console.log(`[registry] ${key}: ${entries.length} entries, ${nonZero.length} active`);
            }
          }
        }
      }

      // ── Set up LSP requestor for our custom provider ──
      {
        let nextReqId = 0;
        const pendingReqs = new Map<
          string,
          {
            resolve: (v: unknown) => void;
            reject: (e: unknown) => void;
            timer: ReturnType<typeof setTimeout>;
            ts: number;
          }
        >();

        const unlisten = await csharpClient.session.onMessage((raw) => {
          const msg = raw as {
            id?: string;
            result?: unknown;
            error?: { message: string };
          };
          if (msg.id && typeof msg.id === "string" && msg.id.startsWith("cl-")) {
            const p = pendingReqs.get(msg.id);
            if (p) {
              pendingReqs.delete(msg.id);
              clearTimeout(p.timer);
              const elapsed = (performance.now() - p.ts).toFixed(0);
              if (msg.error) {
                console.log(`[lspReq] response error id=${msg.id} elapsed=${elapsed}ms:`, msg.error.message);
                p.reject(new Error(msg.error.message || String(msg.error)));
              } else {
                const summary = JSON.stringify(msg.result).slice(0, 200);
                console.log(`[lspReq] response id=${msg.id} elapsed=${elapsed}ms:`, summary);
                p.resolve(msg.result);
              }
            } else {
              console.log(`[lspReq] stale/unknown response id=${msg.id} (already resolved or timed out)`);
            }
          }
        });

        lspRequestorCleanup = () => {
          unlisten();
          for (const [, p] of pendingReqs) {
            clearTimeout(p.timer);
            p.reject(new Error("disposed"));
          }
          pendingReqs.clear();
        };

        lspRequest = (method: string, params: unknown): Promise<unknown> => {
          const cs = csharpClient;
          if (!cs) return Promise.reject(new Error("LSP client not available"));
          return new Promise((resolve, reject) => {
            const id = `cl-${++nextReqId}`;
            console.log(`[lspReq] sending ${method} id=${id} params=`, JSON.stringify(params).slice(0, 300));
            const timer = setTimeout(() => {
              pendingReqs.delete(id);
              console.log(`[lspReq] TIMEOUT ${method} id=${id}`);
              reject(new Error(`LSP request timed out: ${method}`));
            }, 15000);
            pendingReqs.set(id, { resolve, reject, timer, ts: performance.now() });
            cs.session.send({ jsonrpc: "2.0", id, method, params } as never).catch((err) => {
              pendingReqs.delete(id);
              clearTimeout(timer);
              console.log(`[lspReq] send failed ${method} id=${id}:`, err);
              reject(err);
            });
          });
        };

        // Register metadata fetcher: Go-to-Definition on Unity/framework built-in
        // types (MonoBehaviour, Action<T>, …) decompiles the symbol via
        // ICSharpCode.Decompiler (same library OmniSharp bundles).
        // omnisharp/metadata is HTTP-only and not exposed in OmniSharp's LSP mode.
        fsProvider.setMetadataFetcher(async (uriStr: string) => {
          // The URI path gives us the $metadata$ path with forward slashes and
          // URL-encoded chars (e.g. %60 for the backtick in generic type names).
          const metaUri = monaco.Uri.parse(uriStr);
          const metadataPath = metaUri.path.replace(/^\//, ""); // strip leading '/'
          return await ipcInvoke<string>("decompile_metadata", {
            metadataPath,
            workspaceDir: props.workingDir,
          });
        });

        console.log(`[codeLens] lspRequest assigned, about to fire onDidChange`);
      }

      // ── Register real omnisharp/client/findReferences ────────────────
      // Replaces the stub in monacoVscodeServices.ts. Sends
      // textDocument/references via LSP and shows results in Monaco's peek
      // reference widget (editor.action.showReferences).
      import("vscode").then((vscode) => {
        vscode.commands.registerCommand("omnisharp/client/findReferences", async (args: unknown) => {
          const a = args as { uri?: string; range?: { start: { line: number; character: number } } } | undefined;
          console.log(`[findReferences] handler called, uri=${a?.uri}, range=`, JSON.stringify(a?.range));
          if (!a?.uri || !a.range) {
            console.log(`[findReferences] skipped: missing uri or range`);
            return [];
          }
          const req = lspRequest;
          if (!req) {
            console.log(`[findReferences] skipped: lspRequest not ready`);
            return [];
          }
          const t0 = performance.now();
          try {
            const refs = await req("textDocument/references", {
              textDocument: { uri: a.uri },
              position: { line: a.range.start.line, character: a.range.start.character },
              context: { includeDeclaration: false },
            });
            const elapsed = (performance.now() - t0).toFixed(0);
            console.log(`[findReferences] LSP response in ${elapsed}ms, type=${typeof refs}, isArray=${Array.isArray(refs)}`);
            if (!Array.isArray(refs)) {
              console.log(`[findReferences] not an array, raw=`, JSON.stringify(refs).slice(0, 200));
              return [];
            }
            console.log(`[findReferences] got ${refs.length} results`);
            const locations = refs.map((r: any) => ({
              uri: monaco.Uri.parse(r.uri),
              range: lspRangeToMonaco(r.range),
            }));
            if (locations.length === 0) {
              console.log(`[findReferences] no locations to show`);
              return [];
            }
            if (!editor) {
              console.log(`[findReferences] no editor instance, skipping showReferences`);
              return locations;
            }
            const pos = new monaco.Position(
              a.range.start.line + 1,
              a.range.start.character + 1,
            );
            try {
              await vscode.commands.executeCommand(
                "editor.action.showReferences",
                monaco.Uri.parse(a.uri),
                pos,
                locations,
                "peek",
              );
              console.log(`[findReferences] showReferences completed (${locations.length} refs)`);
            } catch (cmdErr) {
              console.warn(`[findReferences] showReferences command failed:`, cmdErr);
            }
            return locations;
          } catch (err) {
            const elapsed = (performance.now() - t0).toFixed(0);
            console.warn(`[findReferences] LSP request failed after ${elapsed}ms:`, err);
            return [];
          }
        });
        console.log(`[findReferences] registered real handler`);
      }).catch((e) => {
        console.warn("[findReferences] failed to import vscode:", e);
      });

      // ── 覆盖 Monaco 内置的 references 相关命令 ─────────────────────
      // 右键/快捷键 Find All References 走的是 Monaco 内部的 CommandsRegistry，
      // vscode.commands.registerCommand 覆盖不了。
      // 右键触发的是 goToReferences / referenceSearch.trigger，Shift+F12 是 findReferences。
      // 全部替换成我们自己的 handler：拿数据 → showReferences。
      for (const id of ["editor.action.findReferences", "editor.action.goToReferences", "editor.action.referenceSearch.trigger"]) {
        CommandsRegistry.registerCommand(id, (_accessor: any, resource: monaco.Uri, position: monaco.Position) => {
          console.log(`[refCmd] override fired for ${id}`);
          (async () => {
            const req = lspRequest;
            // When triggered via right-click context menu, resource/position are not passed —
            // fall back to the current editor's model URI and cursor position.
            const effectiveResource = resource ?? editor?.getModel()?.uri;
            const effectivePosition = position ?? (editor?.getPosition() ?? undefined);
            if (!req || !effectiveResource || !effectivePosition) return;
            try {
              const refs = await req("textDocument/references", {
                textDocument: { uri: effectiveResource.toString() },
                position: { line: effectivePosition.lineNumber - 1, character: effectivePosition.column - 1 },
                context: { includeDeclaration: false },
              });
              if (!Array.isArray(refs) || refs.length === 0) return;
              const locations = refs.map((r: any) => ({
                uri: monaco.Uri.parse(r.uri),
                range: lspRangeToMonaco(r.range),
              }));
              const vscode = await import("vscode");
              await vscode.commands.executeCommand(
                "editor.action.showReferences", effectiveResource, effectivePosition, locations, "peek",
              );
              console.log(`[refCmd] shown ${locations.length} refs (${id})`);
            } catch (err) {
              console.warn(`[refCmd] ${id} failed:`, err);
            }
          })();
        });
      }

      // LSP requestor is ready — fire onDidChange so Monaco re-queries our
      // provider and gets real LSP results instead of the empty placeholder.
      console.log(`[codeLens] firing onDidChange to trigger re-query`);
      codeLensEmitter.fire(codeLensProvider);
      console.log(`[codeLens] onDidChange fired`);

      // LSP handshake complete, but OmniSharp may still be loading projects
      setOmniStatus("initializing", "Loading projects...");

      // Listen for OmniSharp notifications to detect project-load completion.
      // The first textDocument/publishDiagnostics batch signals that project
      // analysis is done. Also listen for process exit so we can show errors.
      const [readyRelease, exitRelease] = await Promise.all([
        csharpClient.session.onMessage((raw) => {
          const msg = raw as {
            method?: string;
            params?: Record<string, unknown>;
          };
          if (msg.method === "textDocument/publishDiagnostics") {
            if (omniReadyTimeout) {
              clearTimeout(omniReadyTimeout);
              omniReadyTimeout = null;
            }
            setOmniStatus("ready", "Ready");
            omniReadyUnlisten?.();
            omniReadyUnlisten = null;
          }
        }),
        csharpClient.session.onExit((info) => {
          if (info.error || (info.code != null && info.code !== 0)) {
            setOmniStatus(
              "error",
              info.error ?? `Exited with code ${info.code}`,
            );
          } else {
            setOmniStatus("disabled", "Process exited");
          }
        }),
      ]);
      omniReadyUnlisten = readyRelease;
      omniExitUnlisten = exitRelease;

      // Timeout fallback: if OmniSharp doesn't send diagnostics within 15 s,
      // consider it ready anyway — better to show a false positive than to
      // leave the user wondering why the dot is still yellow forever.
      omniReadyTimeout = setTimeout(() => {
        if (csharpClient) {
          setOmniStatus("ready", "Ready (estimated)");
        }
        omniReadyUnlisten?.();
        omniReadyUnlisten = null;
        omniReadyTimeout = null;
      }, 15000);
    } catch (err) {
      setOmniStatus(
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
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

  // Clean up listeners and timeouts first
  omniReadyUnlisten?.();
  omniReadyUnlisten = null;
  omniExitUnlisten?.();
  omniExitUnlisten = null;
  if (omniReadyTimeout) {
    clearTimeout(omniReadyTimeout);
    omniReadyTimeout = null;
  }

  if (csharpClientPending) {
    await csharpClientPending.catch(() => {});
    csharpClientPending = null;
  }
  if (csharpClient) {
    const c = csharpClient;
    csharpClient = null;
    await c.stop().catch((err) => {
      console.warn("[lsp] failed to stop C# client on teardown:", err);
    });
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
