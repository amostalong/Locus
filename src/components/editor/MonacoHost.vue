<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from "monaco-editor";

import { useEditorStore, type OpenFile } from "../../stores/editor";
import { createAnimationFrameResizeObserver } from "../../composables/resizeObserver";
import {
  applyVscodeColorTheme,
  ensureMonacoVscodeServices,
} from "../../services/monacoVscodeServices";
import {
  startCsharpLanguageClient,
  type LanguageClientHandle,
} from "../../services/lspClient";
import { findEnclosing, type EnclosingSymbol } from "../../services/codeRefDetect";
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
let csharpClient: LanguageClientHandle | null = null;
let csharpClientPending: Promise<void> | null = null;

function syncModel() {
  if (!editor) return;
  const file = editorStore.active;
  if (file) {
    if (editor.getModel() !== file.model) {
      editor.setModel(file.model);
    }
  } else {
    editor.setModel(null);
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
  if (!dir) return;
  if (csharpClient && csharpClient.workspaceDir === dir) return;
  if (csharpClientPending) {
    await csharpClientPending;
    if (csharpClient && csharpClient.workspaceDir === dir) return;
  }
  csharpClientPending = (async () => {
    if (csharpClient) {
      const old = csharpClient;
      csharpClient = null;
      await old.stop().catch((err) => {
        console.warn("[lsp] failed to stop previous C# client:", err);
      });
    }
    try {
      csharpClient = await startCsharpLanguageClient(dir);
    } catch (err) {
      console.error("[lsp] failed to start C# language client:", err);
    }
  })();
  try {
    await csharpClientPending;
  } finally {
    csharpClientPending = null;
  }
}

async function disposeCsharpClient(): Promise<void> {
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
}

onMounted(async () => {
  if (!container.value) return;

  await ensureMonacoVscodeServices();

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
