<script setup lang="ts">
import type { OpenFile } from "../../stores/editor";

defineProps<{
  files: OpenFile[];
  activeId: string | null;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "close", id: string): void;
}>();

function leafName(relPath: string): string {
  const parts = relPath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || relPath;
}
</script>

<template>
  <div class="ed-tabs" role="tablist">
    <button
      v-for="file in files"
      :key="file.id"
      type="button"
      role="tab"
      class="ed-tab"
      :class="{ active: file.id === activeId, dirty: file.isDirty }"
      :aria-selected="file.id === activeId"
      :title="file.relPath"
      @click="emit('select', file.id)"
      @auxclick.middle.prevent="emit('close', file.id)"
    >
      <span class="ed-tab-name">{{ leafName(file.relPath) }}</span>
      <span
        class="ed-tab-close"
        role="button"
        tabindex="-1"
        :aria-label="`Close ${leafName(file.relPath)}`"
        @click.stop="emit('close', file.id)"
      >
        <svg
          v-if="!file.isDirty"
          viewBox="0 0 12 12"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
        <span v-else class="ed-tab-dirty-dot" aria-hidden="true" />
      </span>
    </button>
  </div>
</template>

<style scoped>
.ed-tabs {
  display: flex;
  align-items: stretch;
  gap: 1px;
  background: var(--sidebar-bg);
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
  scrollbar-width: thin;
  flex: 0 0 auto;
}

.ed-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  max-width: 220px;
  padding: 6px 10px;
  border: 0;
  border-right: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary, var(--text-color));
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  position: relative;
}

.ed-tab:hover {
  background: var(--hover-bg, rgba(127, 127, 127, 0.10));
  color: var(--text-color);
}

.ed-tab.active {
  background: var(--bg-color, var(--sidebar-bg));
  color: var(--text-color);
}

.ed-tab.active::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--accent-color, #5b9bff);
}

.ed-tab-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ed-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  flex: 0 0 16px;
  color: var(--text-secondary, var(--text-color));
  opacity: 0.6;
  transition: opacity 120ms ease, background 120ms ease;
}

.ed-tab:hover .ed-tab-close,
.ed-tab.active .ed-tab-close {
  opacity: 1;
}

.ed-tab-close:hover {
  background: var(--hover-bg, rgba(127, 127, 127, 0.18));
}

.ed-tab.dirty .ed-tab-close {
  opacity: 1;
}

.ed-tab.dirty .ed-tab-close:hover .ed-tab-dirty-dot {
  display: none;
}

.ed-tab.dirty .ed-tab-close:hover::before {
  content: "×";
  font-size: 14px;
  line-height: 1;
}

.ed-tab-dirty-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-color, #5b9bff);
}
</style>
