<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { listDirEntries, type DirEntry } from "../../services/project";
import { editorReadFile } from "../../services/editorFs";
import { languageFromPath } from "../../services/editorLanguage";
import { useUiStore } from "../../stores/ui";
import type { CodeRefAttachment } from "../../types";
import FileTreeNode from "./FileTreeNode.vue";

const props = withDefaults(defineProps<{
  entry: DirEntry;
  depth: number;
  activePath: string | null;
  autoExpandNames?: string[];
  unityView?: boolean;
}>(), {
  autoExpandNames: () => [],
  unityView: false,
});

const emit = defineEmits<{
  (e: "open", relPath: string): void;
}>();

// Known text-safe extensions (mirrors EXT_TO_LANGUAGE in editorLanguage.ts)
const TEXT_EXTS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "json", "jsonc", "vue", "html", "htm", "css", "scss", "less",
  "md", "markdown", "py", "rs", "go", "java", "kt", "cs",
  "c", "h", "cpp", "cc", "cxx", "hpp", "hxx",
  "yaml", "yml", "toml", "xml", "xsd",
  "sh", "bash", "zsh", "ps1", "sql", "rb", "php", "swift", "dart", "lua", "txt",
  // Unity
  "unity", "prefab", "asset", "mat", "meta", "controller", "overridecontroller",
  "anim", "physicsmaterial", "physicsmaterial2d", "lighting", "lightingdataasset",
  "giparams", "mixer", "preset", "playable", "signal", "spriteatlas",
  "spriteatlasv2", "guiskin", "fontsettings", "flare", "cubemap", "brush",
  "terrainlayer", "scenetemplate", "rendertexture", "mask", "mesh",
  "asmdef", "asmref", "shadergraph", "vfx",
  "uxml", "uss",
  "shader", "hlsl", "cginc", "compute",
]);

function isTextFile(path: string): boolean {
  const match = /\.([^./\\]+)$/.exec(path);
  return match ? TEXT_EXTS.has(match[1].toLowerCase()) : false;
}

// Programming language extensions that should use "review" prompt
const CODE_EXTS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "java", "kt", "cs",
  "c", "h", "cpp", "cc", "cxx", "hpp", "hxx",
  "sh", "bash", "zsh", "ps1", "sql", "rb", "php", "swift", "dart", "lua",
  "shader", "hlsl", "cginc", "compute",
  "vue", "html", "htm", "css", "scss", "less",
]);

function isCodeFile(path: string): boolean {
  const match = /\.([^./\\]+)$/.exec(path);
  return match ? CODE_EXTS.has(match[1].toLowerCase()) : false;
}

interface UnityFolderBadge {
  color: string; // CSS variable for badge bg color
  kind: string;  // symbol type: box | dot | circle | angle | play | plus | square
}

const unityFolderBadge = computed((): UnityFolderBadge | null => {
  if (!props.entry.isDir) return null;
  const name = props.entry.name;
  const path = props.entry.relPath;

  // 项目根级特殊目录
  if (name === 'Assets' && path === 'Assets') return { color: 'var(--color-unity-assets)', kind: 'box' };
  if (name === 'Packages' && path === 'Packages') return { color: 'var(--accent-color)', kind: 'square' };

  // 只有 Assets/ 下的子目录才算是 Unity 特殊文件夹
  if (path.startsWith('Assets/')) {
    if (name === 'Editor') return { color: 'var(--color-unity-editor)', kind: 'dot' };
    if (name === 'Resources') return { color: 'var(--color-unity-resources)', kind: 'circle' };
    if (name === 'Plugins') return { color: 'var(--color-unity-plugins)', kind: 'plus' };
    if (name === 'StreamingAssets') return { color: 'var(--color-unity-streaming)', kind: 'arrow-down' };
    if (name === 'Scripts') return { color: 'var(--color-unity-scripts)', kind: 'angle' };
  }

  return null;
});

// 仅 Assets 文件夹用暗肉红色标注文字，其他 Unity 文件夹只保留 badge
const unityFolderColor = computed((): string | null => {
  if (!props.entry.isDir) return null;
  if (props.entry.name === 'Assets' && props.entry.relPath === 'Assets') return 'var(--color-unity-assets)';
  return null;
});

const uiStore = useUiStore();
const shouldExpand = props.entry.isDir && props.autoExpandNames.some(
  (name) => props.entry.name.toLowerCase() === name.toLowerCase(),
);
const expanded = ref(shouldExpand);
const children = ref<DirEntry[] | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);

// -- Context menu --
const ctxMenu = ref<{ x: number; y: number; relPath: string; name: string } | null>(null);

function onRowContextMenu(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  ctxMenu.value = {
    x: event.clientX,
    y: event.clientY,
    relPath: props.entry.relPath,
    name: props.entry.name,
  };
}

function closeContextMenu() {
  ctxMenu.value = null;
}

async function sendToChat() {
  const menu = ctxMenu.value;
  if (!menu) return;
  closeContextMenu();
  try {
    const entry = props.entry;
    if (!entry.isDir && isTextFile(menu.relPath)) {
      const file = await editorReadFile(menu.relPath);
      const lines = file.content.split("\n");
      const ref: CodeRefAttachment = {
        relPath: menu.relPath,
        kind: "file",
        startLine: 1,
        endLine: lines.length,
        language: languageFromPath(menu.relPath),
        excerpt: file.content,
      };
      uiStore.stageCodeRef(ref);
    } else {
      const kind = fileKind(entry, menu.relPath);
      const ref: CodeRefAttachment = {
        relPath: menu.relPath,
        kind: "file",
        startLine: 0,
        endLine: 0,
        language: "plaintext",
        excerpt: `[${kind}] ${menu.relPath}`,
      };
      uiStore.stageCodeRef(ref);
    }
  } catch (err) {
    console.error("[FileTree] sendToChat failed:", err);
  }
}

function fileKind(entry: DirEntry, path: string): string {
  if (entry.isDir) return "directory";
  if (/\.(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(path)) return "image";
  return "binary";
}

async function analyzeFile() {
  const menu = ctxMenu.value;
  if (!menu) return;
  closeContextMenu();
  try {
    const entry = props.entry;
    const relPath = menu.relPath;
    if (!entry.isDir && isTextFile(relPath)) {
      const file = await editorReadFile(relPath);
      const lines = file.content.split("\n");
      const ref: CodeRefAttachment = {
        relPath,
        kind: "file",
        startLine: 1,
        endLine: lines.length,
        language: languageFromPath(relPath),
        excerpt: file.content,
      };
      uiStore.stageCodeRef(ref);
    } else {
      const kind = fileKind(entry, relPath);
      const ref: CodeRefAttachment = {
        relPath,
        kind: "file",
        startLine: 0,
        endLine: 0,
        language: "plaintext",
        excerpt: `[${kind}] ${relPath}`,
      };
      uiStore.stageCodeRef(ref);
    }
    const prefill = entry.isDir
      ? `请分析文件夹 ${menu.name} 内的文件`
      : isCodeFile(relPath)
        ? `请审核 ${menu.name} 文件代码`
        : `请分析 ${menu.name} 文件`;
    uiStore.stageChatPrefill(prefill);
  } catch (err) {
    console.error("[FileTree] analyzeFile failed:", err);
  }
}

function onCtxKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") closeContextMenu();
}

onMounted(() => {
  document.addEventListener("keydown", onCtxKeyDown);
  if (shouldExpand) void ensureChildren();
});
onUnmounted(() => document.removeEventListener("keydown", onCtxKeyDown));

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
    let list = await listDirEntries(props.entry.relPath);
    if (props.unityView) {
      list = list.filter((entry) => {
        if (!entry.isDir) {
          const name = entry.name.toLowerCase();
          if (name.endsWith('.meta') || name.endsWith('.csproj')) return false;
        }
        return true;
      });
    }
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
        'is-unity-folder': !!unityFolderColor,
      }"
      :style="{
        paddingLeft: `${depth * 12 + 8}px`,
        ...(unityFolderColor ? { '--folder-color': unityFolderColor } : {}),
      }"
      :title="entry.relPath"
      @click="handleClick"
      @contextmenu.prevent="onRowContextMenu"
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
          <!-- Unity 文件夹右下角 badge -->
          <g v-if="unityFolderBadge">
            <rect x="9" y="9" width="7" height="7" rx="1.5" :fill="unityFolderBadge.color" stroke="var(--sidebar-bg)" stroke-width=".5" />
            <rect v-if="unityFolderBadge.kind === 'box'" x="10.5" y="10.5" width="4" height="4" rx=".8" fill="white" opacity=".95" />
            <rect v-else-if="unityFolderBadge.kind === 'square'" x="11" y="11" width="3" height="3" rx=".5" fill="white" opacity=".95" />
            <circle v-else-if="unityFolderBadge.kind === 'dot'" cx="12.5" cy="12.5" r="1.5" fill="white" opacity=".95" />
            <circle v-else-if="unityFolderBadge.kind === 'circle'" cx="12.5" cy="12.5" r="2" fill="white" opacity=".95" />
            <path v-else-if="unityFolderBadge.kind === 'arrow-down'" d="M11.5 12l1 1.5 1-1.5M12.5 10.5v3" stroke="white" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity=".95" />
            <path v-else-if="unityFolderBadge.kind === 'plus'" d="M11 12.5h3M12.5 11v3" stroke="white" stroke-width="1" stroke-linecap="round" fill="none" opacity=".95" />
            <path v-else-if="unityFolderBadge.kind === 'angle'" d="M10.5 11.5l1.5 1-1.5 1" stroke="white" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity=".95" />
          </g>
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
        :unity-view="unityView"
        @open="bubbleOpen"
      />
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="ctxMenu"
      class="ft-ctx-backdrop"
      @click="closeContextMenu"
      @contextmenu.prevent="closeContextMenu"
    >
      <div
        class="ft-ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button type="button" class="ft-ctx-item" @click="sendToChat">
          发送到聊天
        </button>
        <button type="button" class="ft-ctx-item" @click="analyzeFile">
          分析文件
        </button>
      </div>
    </div>
  </Teleport>
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

/* Assets 文件夹：文件夹图标与文字同色（暗肉红） */
.ed-tree-row.is-unity-folder .ed-tree-icon {
  color: var(--folder-color) !important;
  opacity: 1;
}

.ed-tree-row.is-unity-folder .ed-tree-name {
  color: var(--folder-color);
  font-weight: 500;
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
  color: var(--text-secondary, #7b8393);
  opacity: 0.75;
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

/* -- Context menu -- */
.ft-ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.ft-ctx-menu {
  position: fixed;
  min-width: 156px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--elevated-bg, var(--panel-bg));
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.24);
}

.ft-ctx-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-color);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.ft-ctx-item:hover {
  background: var(--hover-bg);
}
</style>
