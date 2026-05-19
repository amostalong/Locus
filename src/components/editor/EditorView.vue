<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useEditorStore } from "../../stores/editor";
import { useUiStore } from "../../stores/ui";
import { useNotificationStore } from "../../stores/notification";
import { normalizeAppError } from "../../services/errors";
import type { CodeRefAttachment } from "../../types";
import FileTree from "./FileTree.vue";
import EditorTabs from "./EditorTabs.vue";
import MonacoHost from "./MonacoHost.vue";
import QuickOpenPalette from "./QuickOpenPalette.vue";

const props = defineProps<{
  workingDir: string;
}>();

const editorStore = useEditorStore();
const uiStore = useUiStore();
const notificationStore = useNotificationStore();
const openError = ref<string | null>(null);
const showQuickOpen = ref(false);

const SHIFT_DOUBLE_PRESS_WINDOW_MS = 300;
let lastShiftAt = 0;
let interveningKey = false;

const activeFile = computed(() => editorStore.active);

async function handleOpen(relPath: string) {
  openError.value = null;
  try {
    await editorStore.openFile(relPath);
  } catch (err) {
    const e = normalizeAppError(err);
    openError.value = `[${e.code}] ${e.message}`;
  }
}

function leafName(relPath: string): string {
  const parts = relPath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || relPath;
}

function handleSelectTab(id: string) {
  editorStore.setActive(id);
}

async function handleCloseTab(id: string) {
  const file = editorStore.openFiles.find((f) => f.id === id);
  if (file && file.isDirty) {
    const ok = await confirm(
      `${leafName(file.relPath)} has unsaved changes. Close without saving?`,
      { title: "Close unsaved file", kind: "warning" },
    );
    if (!ok) return;
  }
  editorStore.closeFile(id);
}

async function saveActive(): Promise<void> {
  const file = activeFile.value;
  if (!file || !file.isDirty) return;
  try {
    await editorStore.saveFile(file.id);
  } catch (err) {
    const e = normalizeAppError(err);
    notificationStore.addNotice("error", `Failed to save ${leafName(file.relPath)}: ${e.message}`, {
      code: e.code,
      operation: `editor.save:${file.relPath}`,
      replaceOperation: true,
    });
  }
}

function handleCodeRef(ref: CodeRefAttachment) {
  uiStore.stageCodeRef(ref);
  uiStore.setTab("chat");
}

function isSaveShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "s" && event.key !== "S") return false;
  if (event.altKey || event.shiftKey) return false;
  // Cmd+S on macOS, Ctrl+S elsewhere — accept either to avoid platform sniffing.
  return event.metaKey || event.ctrlKey;
}

function onKeyDown(event: KeyboardEvent) {
  if (uiStore.activeTab !== "editor") return;

  if (
    event.key === "Shift"
    && !event.repeat
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
  ) {
    const now = performance.now();
    if (
      lastShiftAt
      && !interveningKey
      && now - lastShiftAt < SHIFT_DOUBLE_PRESS_WINDOW_MS
    ) {
      lastShiftAt = 0;
      interveningKey = false;
      event.preventDefault();
      showQuickOpen.value = true;
      return;
    }
    lastShiftAt = now;
    interveningKey = false;
    return;
  }

  if (event.key !== "Shift") {
    interveningKey = true;
  }

  if (!isSaveShortcut(event)) return;
  event.preventDefault();
  void saveActive();
}

function handleQuickOpen(relPath: string) {
  showQuickOpen.value = false;
  void handleOpen(relPath);
}

onMounted(() => {
  window.addEventListener("keydown", onKeyDown, { capture: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown, { capture: true });
});
</script>

<template>
  <div class="editor-view">
    <aside class="editor-sidebar">
      <FileTree
        :working-dir="props.workingDir"
        :active-path="activeFile?.relPath ?? null"
        @open="handleOpen"
      />
    </aside>
    <section class="editor-pane">
      <EditorTabs
        v-if="editorStore.openFiles.length"
        :files="editorStore.openFiles"
        :active-id="editorStore.activeFileId"
        @select="handleSelectTab"
        @close="handleCloseTab"
      />
      <div class="editor-pane-body">
        <div v-if="openError" class="editor-pane-error">{{ openError }}</div>
        <div v-if="!activeFile" class="editor-pane-placeholder">
          <p>Click a file in the tree to open it.</p>
          <p class="editor-pane-hint">
            Working directory: <code>{{ props.workingDir || "(not set)" }}</code>
          </p>
        </div>
        <MonacoHost
          v-show="activeFile"
          class="editor-pane-monaco"
          :working-dir="props.workingDir"
          @code-ref="handleCodeRef"
        />
      </div>
      <QuickOpenPalette
        :visible="showQuickOpen"
        @close="showQuickOpen = false"
        @open="handleQuickOpen"
      />
      <footer class="editor-pane-status">
        <span v-if="activeFile" class="editor-pane-status-path">{{ activeFile.relPath }}</span>
        <span v-else class="editor-pane-status-path is-muted">No file open</span>
        <span v-if="activeFile" class="editor-pane-status-flags">
          <span class="editor-pane-status-pill">{{ activeFile.language }}</span>
          <span class="editor-pane-status-pill">{{ activeFile.lineEnding.toUpperCase() }}</span>
          <span v-if="activeFile.hadBom" class="editor-pane-status-pill">BOM</span>
          <span v-if="activeFile.isDirty" class="editor-pane-status-pill is-dirty">● unsaved</span>
        </span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.editor-view {
  display: flex;
  width: 100%;
  height: 100%;
  background: var(--bg-color, var(--sidebar-bg));
  color: var(--text-color);
  overflow: hidden;
}

.editor-sidebar {
  flex: 0 0 260px;
  min-width: 200px;
  max-width: 480px;
  height: 100%;
  overflow: hidden;
}

.editor-pane {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg-color, var(--sidebar-bg));
}

.editor-pane-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.editor-pane-monaco {
  flex: 1 1 auto;
  min-height: 0;
}

.editor-pane-placeholder {
  margin: auto;
  padding: 24px 32px;
  text-align: center;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  max-width: 420px;
  color: var(--text-secondary, var(--text-color));
}

.editor-pane-placeholder code {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--code-bg, rgba(127, 127, 127, 0.12));
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
}

.editor-pane-hint {
  margin: 8px 0 0;
  font-size: 12px;
  opacity: 0.8;
}

.editor-pane-error {
  padding: 8px 12px;
  margin: 8px 12px 0;
  border: 1px solid var(--danger-color, #d04a4a);
  border-radius: 6px;
  color: var(--danger-color, #d04a4a);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  flex: 0 0 auto;
}

.editor-pane-status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 12px;
  border-top: 1px solid var(--border-color);
  background: var(--sidebar-bg);
  font-size: 11px;
  color: var(--text-secondary, var(--text-color));
  flex: 0 0 auto;
}

.editor-pane-status-path {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
}

.editor-pane-status-path.is-muted {
  opacity: 0.6;
  font-family: inherit;
}

.editor-pane-status-flags {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.editor-pane-status-pill {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 10px;
  opacity: 0.85;
}

.editor-pane-status-pill.is-dirty {
  border-color: var(--accent-color, #5b9bff);
  color: var(--accent-color, #5b9bff);
  opacity: 1;
}
</style>
