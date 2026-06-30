<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { t } from "../i18n";
import { acquireSelectionLock } from "../composables/useSelectionLock";

const props = withDefaults(defineProps<{
  thinking: string;
  isThinking: boolean;
  layout?: "side" | "bottom";
  maxSideWidth?: number;
}>(), {
  layout: "side",
  maxSideWidth: undefined,
});

const emit = defineEmits<{
  close: [];
}>();

const contentRef = ref<HTMLElement | null>(null);
const shellRef = ref<HTMLElement | null>(null);

// Persisted dimensions. Wider defaults than the previous hard-coded 340px
// (the panel felt cramped when reasoning text wrapped); localStorage keeps
// the user's chosen size across sessions and panel toggles.
const STORAGE_KEY_WIDTH = "locus:thinkingPanelWidth";
const STORAGE_KEY_HEIGHT = "locus:thinkingPanelHeight";
const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 260;
const MIN_WIDTH = 260;
const MAX_WIDTH = 880;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 520;

const panelWidth = ref(DEFAULT_WIDTH);
const panelHeight = ref(DEFAULT_HEIGHT);
const isDragging = ref(false);
let releaseSelectionLock: (() => void) | null = null;

const layout = computed(() => props.layout);

const effectiveMaxWidth = computed(() => {
  const m = props.maxSideWidth;
  if (typeof m !== "number" || !Number.isFinite(m)) return MAX_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(m)));
});

const effectiveWidth = computed(() =>
  clampWidth(panelWidth.value, effectiveMaxWidth.value),
);
const effectiveHeight = computed(() => clampHeight(panelHeight.value));

const panelStyle = computed(() => {
  if (layout.value === "bottom") {
    return {
      width: "100%",
      minWidth: "0",
      height: `${effectiveHeight.value}px`,
      minHeight: `${effectiveHeight.value}px`,
    };
  }
  return {
    width: `${effectiveWidth.value}px`,
    minWidth: `${effectiveWidth.value}px`,
  };
});

function clampWidth(next: number, maxWidth: number) {
  const n = Number.isFinite(next) ? next : DEFAULT_WIDTH;
  const m = Number.isFinite(maxWidth) ? maxWidth : MAX_WIDTH;
  const upper = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(m)));
  return Math.max(MIN_WIDTH, Math.min(upper, n));
}

function clampHeight(next: number) {
  const n = Number.isFinite(next) ? next : DEFAULT_HEIGHT;
  const upper = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.floor(n)));
  return Math.max(MIN_HEIGHT, Math.min(upper, n));
}

function onResizeMouseDown(event: MouseEvent) {
  event.preventDefault();
  isDragging.value = true;
  releaseSelectionLock?.();
  releaseSelectionLock = acquireSelectionLock();
  document.addEventListener("mousemove", onResizeMouseMove);
  document.addEventListener("mouseup", onResizeMouseUp);
  document.body.style.cursor = layout.value === "bottom" ? "row-resize" : "col-resize";
}

function onResizeMouseMove(event: MouseEvent) {
  if (!isDragging.value || !shellRef.value) return;
  const rect = shellRef.value.getBoundingClientRect();
  if (layout.value === "bottom") {
    panelHeight.value = clampHeight(rect.bottom - event.clientY);
    return;
  }
  panelWidth.value = clampWidth(rect.right - event.clientX, effectiveMaxWidth.value);
}

function stopResize(persist: boolean) {
  if (!isDragging.value && !releaseSelectionLock) return;
  isDragging.value = false;
  document.removeEventListener("mousemove", onResizeMouseMove);
  document.removeEventListener("mouseup", onResizeMouseUp);
  document.body.style.cursor = "";
  releaseSelectionLock?.();
  releaseSelectionLock = null;
  if (!persist) return;
  try {
    if (layout.value === "bottom") {
      localStorage.setItem(STORAGE_KEY_HEIGHT, String(Math.round(effectiveHeight.value)));
    } else {
      localStorage.setItem(STORAGE_KEY_WIDTH, String(Math.round(effectiveWidth.value)));
    }
  } catch {
    // ignore persistence failures (private mode / quota)
  }
}

function onResizeMouseUp() {
  stopResize(true);
}

function onWindowResize() {
  panelWidth.value = clampWidth(panelWidth.value, effectiveMaxWidth.value);
  panelHeight.value = clampHeight(panelHeight.value);
}

watch(() => props.thinking, () => {
  nextTick(() => {
    const el = contentRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
});

onMounted(() => {
  try {
    const savedWidth = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (savedWidth) {
      panelWidth.value = clampWidth(Number(savedWidth), MAX_WIDTH);
    } else {
      // First time the panel opens on this device (or localStorage was cleared):
      // pick a roomier default on bigger viewports so fullscreen / widescreen
      // doesn't feel cramped out of the box. Once the user drags once,
      // localStorage takes over and this branch never runs again.
      const wsWidth = typeof window !== "undefined" ? window.innerWidth : 0;
      if (wsWidth >= 1800) panelWidth.value = 560;
      else if (wsWidth >= 1400) panelWidth.value = 520;
      // else: keep DEFAULT_WIDTH (480) — fine for laptop / small screens
    }
    const savedHeight = localStorage.getItem(STORAGE_KEY_HEIGHT);
    if (savedHeight) {
      panelHeight.value = clampHeight(Number(savedHeight));
    }
  } catch {
    // ignore
  }
  panelWidth.value = clampWidth(panelWidth.value, effectiveMaxWidth.value);
  panelHeight.value = clampHeight(panelHeight.value);
  window.addEventListener("resize", onWindowResize);
});

onUnmounted(() => {
  window.removeEventListener("resize", onWindowResize);
  stopResize(false);
});
</script>

<template>
  <aside
    ref="shellRef"
    class="thinking-panel"
    :class="[
      layout === 'bottom' ? 'layout-bottom' : 'layout-side',
      { 'is-dragging': isDragging },
    ]"
    :style="panelStyle"
  >
    <div class="thinking-panel-resize-handle" @mousedown="onResizeMouseDown" />
    <div class="panel-header">
      <span class="panel-title">
        <span v-if="isThinking" class="thinking-dot" />
        {{ t("thinking.panel.title") }}
      </span>
      <button class="close-btn" @click="emit('close')" :title="t('thinking.panel.close')">&times;</button>
    </div>
    <div ref="contentRef" class="thinking-content">
      <pre v-if="thinking" class="thinking-text">{{ thinking }}</pre>
      <div v-else class="empty-hint">{{ t("thinking.panel.empty") }}</div>
    </div>
  </aside>
</template>

<style scoped>
.thinking-panel {
  position: relative;
  background: var(--sidebar-bg);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  user-select: text;
  flex-shrink: 0;
}

.thinking-panel.layout-bottom {
  border-left: none;
  border-top: 1px solid var(--border-color);
}

.thinking-panel-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 4px;
  cursor: col-resize;
  z-index: 2;
  background: transparent;
  transition: background-color 120ms ease;
}

.thinking-panel.layout-bottom .thinking-panel-resize-handle {
  top: 0;
  left: 0;
  right: 0;
  bottom: auto;
  width: auto;
  height: 4px;
  cursor: row-resize;
}

.thinking-panel-resize-handle:hover,
.thinking-panel.is-dragging .thinking-panel-resize-handle {
  background: var(--accent-color, #3b82f6);
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.panel-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.thinking-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3b82f6;
  animation: pulse 1.2s ease-in-out infinite;
  flex-shrink: 0;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.1); }
}

.close-btn {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  box-shadow: none;
  flex-shrink: 0;
}

.close-btn:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

.thinking-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}

.thinking-text {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-prose);
  margin: 0;
}

.empty-hint {
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 24px 0;
}
</style>