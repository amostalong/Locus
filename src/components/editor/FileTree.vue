<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { listDirEntries, type DirEntry } from "../../services/project";
import FileTreeNode from "./FileTreeNode.vue";

const props = defineProps<{
  workingDir: string;
  activePath: string | null;
}>();

const emit = defineEmits<{
  (e: "open", relPath: string): void;
}>();

const entries = ref<DirEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

function sortEntries(list: DirEntry[]): DirEntry[] {
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

async function loadRoot() {
  if (!props.workingDir) {
    entries.value = [];
    error.value = null;
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const list = await listDirEntries("");
    entries.value = sortEntries(list);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

function handleOpen(relPath: string) {
  emit("open", relPath);
}

onMounted(loadRoot);
watch(() => props.workingDir, loadRoot);

defineExpose({ refresh: loadRoot });
</script>

<template>
  <div class="ed-tree" :data-empty="entries.length === 0">
    <div class="ed-tree-header">
      <span class="ed-tree-title">Files</span>
      <button
        type="button"
        class="ed-tree-refresh"
        title="Refresh"
        :disabled="loading"
        @click="loadRoot"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
          <path
            d="M8 3a5 5 0 0 1 4.546 2.914l1.05-.6A6 6 0 1 0 14 8h-1.05A5 5 0 1 1 8 3zm4.95 1.04L11 5.5h3v-3l-1.05 1.04z"
          />
        </svg>
      </button>
    </div>
    <div class="ed-tree-body">
      <div v-if="loading && entries.length === 0" class="ed-tree-state">Loading…</div>
      <div v-else-if="error" class="ed-tree-state is-error" :title="error">{{ error }}</div>
      <div v-else-if="!workingDir" class="ed-tree-state">No working directory</div>
      <div v-else-if="entries.length === 0" class="ed-tree-state">(empty)</div>
      <FileTreeNode
        v-for="entry in entries"
        :key="entry.relPath"
        :entry="entry"
        :depth="0"
        :active-path="activePath"
        @open="handleOpen"
      />
    </div>
  </div>
</template>

<style scoped>
.ed-tree {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border-color);
  overflow: hidden;
}

.ed-tree-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary, var(--text-color));
}

.ed-tree-title {
  flex: 1 1 auto;
}

.ed-tree-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.ed-tree-refresh:hover {
  background: var(--hover-bg, rgba(127, 127, 127, 0.15));
}

.ed-tree-refresh:disabled {
  opacity: 0.5;
  cursor: progress;
}

.ed-tree-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px 0;
}

.ed-tree-state {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-secondary, var(--text-color));
  opacity: 0.7;
}

.ed-tree-state.is-error {
  color: var(--danger-color, #d04a4a);
  opacity: 0.9;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
