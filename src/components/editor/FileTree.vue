<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { listDirEntries, type DirEntry } from "../../services/project";
import { deriveAutoExpandPaths } from "./fileTreeAutoExpand";
import FileTreeNode from "./FileTreeNode.vue";

const props = withDefaults(defineProps<{
  workingDir: string;
  activePath: string | null;
  autoExpandNames?: string[];
}>(), {
  autoExpandNames: () => [],
});

const emit = defineEmits<{
  (e: "open", relPath: string): void;
}>();

const entries = ref<DirEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const unityView = ref(true);

// Ancestor directory paths of the active file. Each FileTreeNode that
// matches its own relPath against this list is forced open so the active
// row becomes reachable without the user having to navigate the tree first.
const autoExpandPaths = computed<string[]>(() => deriveAutoExpandPaths(props.activePath));

function sortEntries(list: DirEntry[]): DirEntry[] {
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Unity View 过滤器：隐藏 .meta、.csproj 和根目录无关文件夹 */
function filterUnityView(list: DirEntry[], isRoot: boolean): DirEntry[] {
  if (!unityView.value) return list;
  return list.filter((entry) => {
    if (!entry.isDir) {
      const name = entry.name.toLowerCase();
      if (name.endsWith('.meta') || name.endsWith('.csproj')) return false;
      return true;
    }
    if (isRoot) {
      return entry.name === 'Assets' || entry.name === 'Packages';
    }
    return true;
  });
}

function toggleUnityView() {
  unityView.value = !unityView.value;
  void loadRoot();
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
    entries.value = sortEntries(filterUnityView(list, true));
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

// -- Reveal active file: scroll the active row into view ---------------
// The ancestor chain may need to be loaded asynchronously (one Tauri
// `list_dir` per level), so we poll for the row rather than assuming
// it's in the DOM on the same tick that `activePath` changes.
const rootEl = ref<HTMLElement | null>(null);
let scrollPollTimer: number | null = null;
const SCROLL_POLL_INTERVAL_MS = 60;
const SCROLL_POLL_MAX_ATTEMPTS = 25; // ~1.5s — covers a few deep levels

function stopScrollPoll() {
  if (scrollPollTimer !== null) {
    window.clearInterval(scrollPollTimer);
    scrollPollTimer = null;
  }
}

function scrollActiveIntoView() {
  stopScrollPoll();
  if (!props.activePath) return;
  const root = rootEl.value;
  if (!root) return;
  let attempts = 0;
  scrollPollTimer = window.setInterval(() => {
    const row = root.querySelector<HTMLElement>(".ed-tree-row.is-active");
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      stopScrollPoll();
      return;
    }
    if (++attempts >= SCROLL_POLL_MAX_ATTEMPTS) {
      stopScrollPoll();
    }
  }, SCROLL_POLL_INTERVAL_MS);
}

onMounted(loadRoot);
watch(() => props.workingDir, loadRoot);

// Trigger reveal whenever the active file changes (covers FileTree click,
// QuickOpen, F12 goto, Chat code refs, Diff open, etc., since they all
// flow through `editorStore.activeFileId` → `active-path`).
watch(
  () => props.activePath,
  () => scrollActiveIntoView(),
  { immediate: true },
);

onBeforeUnmount(stopScrollPoll);

defineExpose({ refresh: loadRoot });
</script>

<template>
  <div ref="rootEl" class="ed-tree" :data-empty="entries.length === 0">
    <div class="ed-tree-header">
      <span class="ed-tree-title">Files</span>
      <button
        type="button"
        class="ed-tree-toggle"
        :class="{ active: unityView }"
        title="Unity View: 隐藏 .meta/.csproj 及根目录无关文件夹"
        @click="toggleUnityView"
      >
        <svg v-if="unityView" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
          <path d="M8 3C4.5 3 1.5 5.5 0 8c1.5 2.5 4.5 5 8 5s6.5-2.5 8-5c-1.5-2.5-4.5-5-8-5zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
          <line x1="2" y1="2" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <svg v-else viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
          <path d="M8 3C4.5 3 1.5 5.5 0 8c1.5 2.5 4.5 5 8 5s6.5-2.5 8-5c-1.5-2.5-4.5-5-8-5zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
        </svg>
      </button>
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
        :auto-expand-names="autoExpandNames"
        :auto-expand-paths="autoExpandPaths"
        :unity-view="unityView"
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
  border-left: 1px solid var(--border-color);
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

.ed-tree-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0.6;
}

.ed-tree-toggle:hover {
  background: var(--hover-bg, rgba(127, 127, 127, 0.15));
  opacity: 1;
}

.ed-tree-toggle.active {
  color: var(--accent-color);
  opacity: 1;
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
