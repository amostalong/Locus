<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { searchWorkspaceEntries } from "../../services/project";
import { searchWorkspaceAssets } from "../../services/asset";

interface QuickOpenItem {
  relPath: string;
  name: string;
  parentPath: string;
}

const ASSET_SEARCH_ROOTS = ["Assets", "Packages", "ProjectSettings"];

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open", relPath: string): void;
}>();

const query = ref("");
const results = ref<QuickOpenItem[]>([]);
const loading = ref(false);
const selectedIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLUListElement | null>(null);

let requestSeq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      query.value = "";
      results.value = [];
      selectedIndex.value = 0;
      loading.value = false;
      nextTick(() => {
        inputEl.value?.focus();
        inputEl.value?.select();
      });
      return;
    }
    clearDebounce();
    requestSeq += 1;
    loading.value = false;
  },
);

watch(query, (next) => {
  clearDebounce();
  selectedIndex.value = 0;
  const trimmed = next.trim();
  if (!trimmed) {
    results.value = [];
    loading.value = false;
    requestSeq += 1;
    return;
  }
  loading.value = true;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runSearch(trimmed);
  }, 120);
});

watch(selectedIndex, () => {
  nextTick(() => {
    const list = listEl.value;
    if (!list) return;
    const child = list.children[selectedIndex.value] as HTMLElement | undefined;
    child?.scrollIntoView({ block: "nearest" });
  });
});

function clearDebounce() {
  if (!debounceTimer) return;
  clearTimeout(debounceTimer);
  debounceTimer = null;
}

function parentPathOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx >= 0 ? relPath.slice(0, idx) : "";
}

async function runSearch(trimmed: string) {
  const seq = ++requestSeq;
  try {
    const [assetSettled, entrySettled] = await Promise.allSettled([
      searchWorkspaceAssets(trimmed, ASSET_SEARCH_ROOTS),
      searchWorkspaceEntries(trimmed, 60),
    ]);
    if (seq !== requestSeq) return;

    const merged: QuickOpenItem[] = [];
    const seen = new Set<string>();

    if (assetSettled.status === "fulfilled") {
      for (const r of assetSettled.value) {
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        merged.push({
          relPath: r.path,
          name: r.name,
          parentPath: parentPathOf(r.path),
        });
      }
    }

    if (entrySettled.status === "fulfilled") {
      for (const r of entrySettled.value) {
        if (r.isDir) continue;
        if (seen.has(r.relPath)) continue;
        seen.add(r.relPath);
        merged.push({
          relPath: r.relPath,
          name: r.name,
          parentPath: r.parentPath,
        });
      }
    }

    results.value = merged.slice(0, 60);
    selectedIndex.value = 0;
  } catch {
    if (seq !== requestSeq) return;
    results.value = [];
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function select(index: number) {
  const item = results.value[index];
  if (!item) return;
  emit("open", item.relPath);
  emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    if (results.value.length === 0) return;
    event.preventDefault();
    selectedIndex.value = (selectedIndex.value + 1) % results.value.length;
    return;
  }
  if (event.key === "ArrowUp") {
    if (results.value.length === 0) return;
    event.preventDefault();
    selectedIndex.value =
      (selectedIndex.value - 1 + results.value.length) % results.value.length;
    return;
  }
  if (event.key === "Enter") {
    if (results.value.length === 0) return;
    event.preventDefault();
    select(selectedIndex.value);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="quick-open-overlay">
      <div
        v-if="props.visible"
        class="quick-open-overlay"
        @mousedown.self="emit('close')"
      >
        <div class="quick-open-panel" role="dialog" aria-label="Quick open file">
          <input
            ref="inputEl"
            v-model="query"
            class="quick-open-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="Search files…"
            @keydown="onKeydown"
          />
          <div v-if="loading" class="quick-open-status">Searching…</div>
          <div v-else-if="!query.trim()" class="quick-open-status">
            Type to search files
          </div>
          <div v-else-if="results.length === 0" class="quick-open-status">
            No matches
          </div>
          <ul v-else ref="listEl" class="quick-open-list">
            <li
              v-for="(item, i) in results"
              :key="item.relPath"
              :class="{ highlighted: i === selectedIndex }"
              @mouseenter="selectedIndex = i"
              @mousedown.prevent="select(i)"
            >
              <span class="qo-name">{{ item.name }}</span>
              <span v-if="item.parentPath" class="qo-path">{{ item.parentPath }}</span>
            </li>
          </ul>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.quick-open-overlay {
  position: fixed;
  inset: 0;
  z-index: 320;
  display: flex;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(2px);
}

.quick-open-panel {
  width: min(640px, 86vw);
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-elevated, var(--panel-bg));
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.32);
  overflow: hidden;
}

.quick-open-input {
  flex: 0 0 auto;
  width: 100%;
  padding: 14px 18px;
  border: none;
  border-bottom: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-color);
  font-size: 15px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  outline: none;
}

.quick-open-input::placeholder {
  color: var(--text-secondary, var(--text-color));
  opacity: 0.6;
}

.quick-open-status {
  padding: 16px 18px;
  color: var(--text-secondary, var(--text-color));
  font-size: 12px;
  text-align: center;
}

.quick-open-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
}

.quick-open-list li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 7px;
  cursor: pointer;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
}

.quick-open-list li.highlighted {
  background: color-mix(in srgb, var(--accent-soft) 70%, var(--hover-bg) 30%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-color) 24%, transparent);
}

.qo-name {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.qo-path {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--text-secondary, var(--text-color));
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.quick-open-overlay-enter-active,
.quick-open-overlay-leave-active {
  transition: opacity 0.12s ease;
}

.quick-open-overlay-enter-active .quick-open-panel,
.quick-open-overlay-leave-active .quick-open-panel {
  transition: transform 0.14s ease, opacity 0.14s ease;
}

.quick-open-overlay-enter-from,
.quick-open-overlay-leave-to {
  opacity: 0;
}

.quick-open-overlay-enter-from .quick-open-panel,
.quick-open-overlay-leave-to .quick-open-panel {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}
</style>
