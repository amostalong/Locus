<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

import { useEditorStore } from "../../stores/editor";
import { createAnimationFrameResizeObserver } from "../../composables/resizeObserver";

const monacoEnv: monaco.Environment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = monacoEnv;

function resolveMonacoTheme(): string {
  const themeAttr = document.documentElement.getAttribute("data-theme");
  return themeAttr === "light" ? "vs" : "vs-dark";
}

const editorStore = useEditorStore();
const container = ref<HTMLElement | null>(null);

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let resizeHandle: ReturnType<typeof createAnimationFrameResizeObserver> | null = null;
let themeObserver: MutationObserver | null = null;

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
}

function applyTheme() {
  monaco.editor.setTheme(resolveMonacoTheme());
}

onMounted(() => {
  if (!container.value) return;

  applyTheme();

  editor = monaco.editor.create(container.value, {
    model: null,
    theme: resolveMonacoTheme(),
    automaticLayout: false,
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderWhitespace: "selection",
    smoothScrolling: true,
    tabSize: 2,
    wordWrap: "off",
  });

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
});

watch(() => editorStore.active, syncModel);

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  themeObserver = null;
  resizeHandle?.disconnect();
  resizeHandle = null;
  // Detach model before disposing so we don't dispose models the store still owns.
  editor?.setModel(null);
  editor?.dispose();
  editor = null;
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
