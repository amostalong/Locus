<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "../../i18n";
import { useEditorStore } from "../../stores/editor";
import { normalizeAppError } from "../../services/errors";
import FileTree from "./FileTree.vue";
import MonacoHost from "./MonacoHost.vue";

const props = defineProps<{
  workingDir: string;
}>();

const editorStore = useEditorStore();
const openError = ref<string | null>(null);

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
      <header class="editor-pane-header">
        <span class="editor-pane-title">{{ t("app.tab.editor") }}</span>
        <span v-if="activeFile" class="editor-pane-meta">
          <code>{{ activeFile.relPath }}</code>
          <span class="editor-pane-pill">{{ activeFile.language }}</span>
          <span class="editor-pane-pill">{{ activeFile.lineEnding.toUpperCase() }}</span>
          <span v-if="activeFile.hadBom" class="editor-pane-pill">BOM</span>
          <span v-if="activeFile.isDirty" class="editor-pane-pill is-dirty">●</span>
        </span>
      </header>
      <div class="editor-pane-body">
        <div v-if="openError" class="editor-pane-error">{{ openError }}</div>
        <div v-if="!activeFile" class="editor-pane-placeholder">
          <p>Click a file in the tree to open it.</p>
          <p class="editor-pane-hint">
            Working directory: <code>{{ props.workingDir || "(not set)" }}</code>
          </p>
        </div>
        <MonacoHost v-show="activeFile" class="editor-pane-monaco" />
      </div>
      <footer v-if="editorStore.openFiles.length" class="editor-pane-footer">
        <span class="editor-pane-footer-label">Open ({{ editorStore.openFiles.length }}):</span>
        <button
          v-for="file in editorStore.openFiles"
          :key="file.id"
          type="button"
          class="editor-pane-tab"
          :class="{ active: file.id === editorStore.activeFileId, dirty: file.isDirty }"
          :title="file.relPath"
          @click="editorStore.setActive(file.id)"
        >
          <span class="editor-pane-tab-name">{{ file.relPath }}</span>
          <span
            class="editor-pane-tab-close"
            role="button"
            aria-label="Close"
            @click.stop="editorStore.closeFile(file.id)"
          >×</span>
        </button>
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

.editor-pane-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
}

.editor-pane-title {
  font-weight: 600;
  color: var(--text-secondary, var(--text-color));
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 11px;
}

.editor-pane-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary, var(--text-color));
}

.editor-pane-meta code {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--code-bg, rgba(127, 127, 127, 0.12));
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
  color: var(--text-color);
}

.editor-pane-pill {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.85;
}

.editor-pane-pill.is-dirty {
  border-color: var(--accent-color, #5b9bff);
  color: var(--accent-color, #5b9bff);
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
  margin-bottom: 12px;
  border: 1px solid var(--danger-color, #d04a4a);
  border-radius: 6px;
  color: var(--danger-color, #d04a4a);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.editor-pane-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid var(--border-color);
  overflow-x: auto;
  background: var(--sidebar-bg);
}

.editor-pane-footer-label {
  font-size: 11px;
  color: var(--text-secondary, var(--text-color));
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-right: 4px;
  flex: 0 0 auto;
}

.editor-pane-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--border-color);
  background: transparent;
  border-radius: 4px;
  color: var(--text-color);
  font-size: 12px;
  cursor: pointer;
  flex: 0 0 auto;
  max-width: 220px;
}

.editor-pane-tab:hover {
  background: var(--hover-bg, rgba(127, 127, 127, 0.12));
}

.editor-pane-tab.active {
  border-color: var(--accent-color, #5b9bff);
  color: var(--accent-color, #5b9bff);
}

.editor-pane-tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-pane-tab.dirty .editor-pane-tab-name::after {
  content: " ●";
  color: var(--accent-color, #5b9bff);
}

.editor-pane-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
}

.editor-pane-tab-close:hover {
  background: var(--hover-bg, rgba(127, 127, 127, 0.18));
}
</style>
