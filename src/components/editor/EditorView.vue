<script setup lang="ts">
import { t } from "../../i18n";

defineProps<{
  workingDir: string;
}>();
</script>

<template>
  <div class="editor-view">
    <div class="editor-placeholder">
      <h2>{{ t("app.tab.editor") }}</h2>
      <p class="editor-placeholder-hint">
        Working directory: <code>{{ workingDir || "(not set)" }}</code>
      </p>
      <p class="editor-placeholder-hint">Editor scaffold mounted. File tree and Monaco coming next.</p>
    </div>
  </div>
</template>

<style scoped>
.editor-view {
  display: flex;
  width: 100%;
  height: 100%;
  background: var(--bg-color, var(--sidebar-bg));
  color: var(--text-color);
}

.editor-placeholder {
  margin: auto;
  padding: 32px 40px;
  text-align: center;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  background: var(--sidebar-bg);
}

.editor-placeholder h2 {
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 600;
}

.editor-placeholder-hint {
  margin: 6px 0;
  font-size: 13px;
  color: var(--text-secondary, var(--text-color));
  opacity: 0.8;
}

.editor-placeholder-hint code {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--code-bg, rgba(127, 127, 127, 0.12));
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
}
</style>
