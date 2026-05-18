<script setup lang="ts">
import { ref } from "vue";
import { listDirEntries, type DirEntry } from "../../services/project";
import FileTreeNode from "./FileTreeNode.vue";

const props = defineProps<{
  entry: DirEntry;
  depth: number;
  activePath: string | null;
}>();

const emit = defineEmits<{
  (e: "open", relPath: string): void;
}>();

const expanded = ref(false);
const children = ref<DirEntry[] | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);

function sortEntries(list: DirEntry[]): DirEntry[] {
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

async function ensureChildren() {
  if (children.value !== null || loading.value) return;
  loading.value = true;
  loadError.value = null;
  try {
    const list = await listDirEntries(props.entry.relPath);
    children.value = sortEntries(list);
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
    children.value = [];
  } finally {
    loading.value = false;
  }
}

async function handleClick() {
  if (props.entry.isDir) {
    expanded.value = !expanded.value;
    if (expanded.value) await ensureChildren();
  } else {
    emit("open", props.entry.relPath);
  }
}

function bubbleOpen(relPath: string) {
  emit("open", relPath);
}
</script>

<template>
  <div class="ed-tree-row-wrap">
    <button
      type="button"
      class="ed-tree-row"
      :class="{
        'is-dir': entry.isDir,
        'is-file': !entry.isDir,
        'is-active': !entry.isDir && activePath === entry.relPath,
      }"
      :style="{ paddingLeft: `${depth * 12 + 8}px` }"
      :title="entry.relPath"
      @click="handleClick"
    >
      <span class="ed-tree-twisty" aria-hidden="true">
        <template v-if="entry.isDir">
          <svg
            class="ed-tree-chev"
            :class="{ open: expanded }"
            viewBox="0 0 16 16"
            width="10"
            height="10"
            fill="currentColor"
          >
            <path d="M6 4l4 4-4 4z" />
          </svg>
        </template>
      </span>
      <span class="ed-tree-icon" aria-hidden="true">
        <svg v-if="entry.isDir" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path
            d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z"
          />
        </svg>
        <svg v-else viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path
            d="M3 1.5A1.5 1.5 0 0 1 4.5 0h5.379a1.5 1.5 0 0 1 1.06.44l2.122 2.12A1.5 1.5 0 0 1 13.5 3.62V14.5A1.5 1.5 0 0 1 12 16H4.5A1.5 1.5 0 0 1 3 14.5v-13zM10 1.5V3.5a.5.5 0 0 0 .5.5h2L10 1.5z"
          />
        </svg>
      </span>
      <span class="ed-tree-name">{{ entry.name }}</span>
    </button>
    <div v-if="entry.isDir && expanded" class="ed-tree-children">
      <div v-if="loading" class="ed-tree-hint" :style="{ paddingLeft: `${(depth + 1) * 12 + 8}px` }">
        Loading…
      </div>
      <div
        v-else-if="loadError"
        class="ed-tree-hint is-error"
        :style="{ paddingLeft: `${(depth + 1) * 12 + 8}px` }"
        :title="loadError"
      >
        Failed to load
      </div>
      <div
        v-else-if="children && children.length === 0"
        class="ed-tree-hint"
        :style="{ paddingLeft: `${(depth + 1) * 12 + 8}px` }"
      >
        (empty)
      </div>
      <FileTreeNode
        v-for="child in children ?? []"
        :key="child.relPath"
        :entry="child"
        :depth="depth + 1"
        :active-path="activePath"
        @open="bubbleOpen"
      />
    </div>
  </div>
</template>

<style scoped>
.ed-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 2px 8px 2px 8px;
  border: 0;
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
  text-align: left;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ed-tree-row:hover {
  background: var(--hover-bg, rgba(127, 127, 127, 0.12));
}

.ed-tree-row.is-active {
  background: var(--accent-bg, rgba(64, 128, 255, 0.18));
}

.ed-tree-twisty {
  display: inline-flex;
  width: 12px;
  justify-content: center;
  flex: 0 0 12px;
  color: var(--text-secondary, var(--text-color));
}

.ed-tree-chev {
  transition: transform 120ms ease;
  opacity: 0.7;
}

.ed-tree-chev.open {
  transform: rotate(90deg);
}

.ed-tree-icon {
  display: inline-flex;
  flex: 0 0 14px;
  color: var(--text-secondary, var(--text-color));
  opacity: 0.85;
}

.ed-tree-row.is-dir .ed-tree-icon {
  color: var(--accent-color, #5b9bff);
  opacity: 1;
}

.ed-tree-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ed-tree-hint {
  font-size: 12px;
  color: var(--text-secondary, var(--text-color));
  opacity: 0.6;
  padding: 2px 8px;
}

.ed-tree-hint.is-error {
  color: var(--danger-color, #d04a4a);
  opacity: 0.85;
}
</style>
