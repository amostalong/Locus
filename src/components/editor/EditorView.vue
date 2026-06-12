<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useResizablePanel } from "../../composables/useResizablePanel";
import { useEditorStore } from "../../stores/editor";
import { useUiStore } from "../../stores/ui";
import { useNotificationStore } from "../../stores/notification";
import { useOmnisharpStatus } from "../../composables/useOmnisharpStatus";
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

const { state: omniState, detail: omniDetail, name: omniName } = useOmnisharpStatus();

const omniLabel = computed(() => {
  switch (omniState.value) {
    case "disabled":
      return "—";
    case "connecting":
      return "starting…";
    case "initializing":
      return "loading…";
    case "ready":
      return "ready";
    case "error":
      return "error";
  }
});

const editorViewRef = ref<HTMLElement | null>(null);
const { size: sidebarWidth, isDragging: isSidebarDragging, onMouseDown: onSidebarDividerMouseDown } =
  useResizablePanel(editorViewRef, {
    storageKey: "locus-editor-sidebar-width",
    defaultSize: 260,
    minSize: 200,
    maxSize: (container) => Math.round(container.clientWidth * 0.65),
    direction: "horizontal",
  });

let sidebarResizeObserver: ResizeObserver | null = null;

async function handleOpen(relPath: string) {
  openError.value = null;
  try {
    await editorStore.openFile(relPath);
  } catch (err) {
    console.error("[editor] openFile failed for", relPath, err);
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
  // Chat panel is always visible, will pick up the staged ref automatically
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

  // When the container grows (e.g. window maximized), ensure the sidebar
  // is at least 1/5 of the total width so it doesn't feel squeezed.
  const el = editorViewRef.value;
  if (el) {
    sidebarResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w <= 0) continue;
        const minFifth = Math.round(w / 5);
        if (sidebarWidth.value < minFifth) {
          sidebarWidth.value = minFifth;
        }
      }
    });
    sidebarResizeObserver.observe(el);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown, { capture: true });
  sidebarResizeObserver?.disconnect();
  sidebarResizeObserver = null;
});
</script>

<template>
  <div ref="editorViewRef" class="editor-view">
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
        <span
          class="editor-pane-status-omnisharp"
          :class="`is-${omniState}`"
          :title="`${omniName}: ${omniLabel}${omniDetail ? '\n' + omniDetail : ''}`"
        >
          <span class="omnisharp-dot" />
          <span class="omnisharp-label">{{ omniName }} {{ omniLabel }}</span>
        </span>
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
    <div
      class="split-divider editor-sidebar-divider"
      :class="{ 'is-dragging': isSidebarDragging }"
      @mousedown="onSidebarDividerMouseDown"
    ></div>
    <aside class="editor-sidebar" :style="{ width: sidebarWidth + 'px' }">
      <FileTree
        :working-dir="props.workingDir"
        :active-path="activeFile?.relPath ?? null"
        :auto-expand-names="['Assets']"
        @open="handleOpen"
      />
    </aside>
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
  flex: none;
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
  overflow: hidden;
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

.editor-pane-status-omnisharp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  margin-right: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  user-select: none;
  transition: border-color 0.3s, color 0.3s, background 0.3s;
}

/* ---------- disabled: mute + static ---------- */
.editor-pane-status-omnisharp.is-disabled {
  opacity: 0.45;
}

/* ---------- error: red shake ---------- */
.editor-pane-status-omnisharp.is-error {
  border-color: var(--danger-color, #d04a4a);
  color: var(--danger-color, #d04a4a);
  background: color-mix(in srgb, var(--danger-color, #d04a4a) 8%, transparent);
  animation: omnisharp-shake 0.5s ease-in-out;
}

/* ---------- ready: green glow pulse ---------- */
.editor-pane-status-omnisharp.is-ready {
  border-color: color-mix(in srgb, var(--success-color, #3fb950) 60%, var(--border-color));
  color: var(--success-color, #3fb950);
  background: color-mix(in srgb, var(--success-color, #3fb950) 6%, transparent);
  animation: omnisharp-ready-glow 2s ease-in-out infinite;
}

/* ---------- connecting: blue spin ---------- */
.editor-pane-status-omnisharp.is-connecting {
  border-color: color-mix(in srgb, var(--accent-color, #5b9bff) 60%, var(--border-color));
  color: var(--accent-color, #5b9bff);
  background: color-mix(in srgb, var(--accent-color, #5b9bff) 6%, transparent);
}

/* ---------- initializing: orange scanning ---------- */
.editor-pane-status-omnisharp.is-initializing {
  border-color: color-mix(in srgb, var(--warning-color, #e5a100) 60%, var(--border-color));
  color: var(--warning-color, #e5a100);
  background: color-mix(in srgb, var(--warning-color, #e5a100) 8%, transparent);
  animation: omnisharp-scan 1.6s ease-in-out infinite;
}

/* ==================== DOTS ==================== */

/* Shared dot base */
.omnisharp-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* disabled: static gray */
.editor-pane-status-omnisharp.is-disabled .omnisharp-dot {
  background: var(--text-secondary, #888);
}

/* connecting: rotating ring spinner */
.editor-pane-status-omnisharp.is-connecting .omnisharp-dot {
  background: transparent;
  border: 2px solid transparent;
  border-top-color: var(--accent-color, #5b9bff);
  border-right-color: var(--accent-color, #5b9bff);
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  animation: omnisharp-spin 0.8s linear infinite;
}

/* initializing: scanning ring (slower, with color sweep) */
.editor-pane-status-omnisharp.is-initializing .omnisharp-dot {
  background: transparent;
  border: 2px solid color-mix(in srgb, var(--warning-color, #e5a100) 30%, transparent);
  border-top-color: var(--warning-color, #e5a100);
  width: 10px;
  height: 10px;
  box-sizing: border-box;
  animation: omnisharp-spin 1.2s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
}

/* ready: green breathing dot */
.editor-pane-status-omnisharp.is-ready .omnisharp-dot {
  background: var(--success-color, #3fb950);
  animation: omnisharp-ready-dot 2s ease-in-out infinite;
}

/* error: red static dot */
.editor-pane-status-omnisharp.is-error .omnisharp-dot {
  background: var(--danger-color, #d04a4a);
}

/* ==================== KEYFRAMES ==================== */

/* ring spinner (connecting / initializing) */
@keyframes omnisharp-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* ready glow on the pill border */
@keyframes omnisharp-ready-glow {
  0%, 100% {
    border-color: color-mix(in srgb, var(--success-color, #3fb950) 40%, var(--border-color));
    box-shadow: 0 0 0 transparent;
  }
  50% {
    border-color: color-mix(in srgb, var(--success-color, #3fb950) 80%, var(--border-color));
    box-shadow: 0 0 6px color-mix(in srgb, var(--success-color, #3fb950) 30%, transparent);
  }
}

/* ready dot breathing */
@keyframes omnisharp-ready-dot {
  0%, 100% {
    transform: scale(1);
    opacity: 1;
    box-shadow: 0 0 0 transparent;
  }
  50% {
    transform: scale(1.35);
    opacity: 0.85;
    box-shadow: 0 0 4px var(--success-color, #3fb950);
  }
}

/* initializing scan effect on the whole pill */
@keyframes omnisharp-scan {
  0%, 100% {
    background: color-mix(in srgb, var(--warning-color, #e5a100) 8%, transparent);
  }
  50% {
    background: color-mix(in srgb, var(--warning-color, #e5a100) 18%, transparent);
  }
}

/* error shake */
@keyframes omnisharp-shake {
  0%, 100% { transform: translateX(0); }
  10%, 30%, 50%, 70%, 90% { transform: translateX(-2px); }
  20%, 40%, 60%, 80% { transform: translateX(2px); }
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

.editor-sidebar-divider {
  width: 4px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  position: relative;
  z-index: 10;
}

.editor-sidebar-divider:hover,
.editor-sidebar-divider.is-dragging {
  background: var(--accent-color);
}
</style>
