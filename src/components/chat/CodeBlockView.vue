<script setup lang="ts">
import { computed } from "vue";
import hljs from "../../hljs";
import { renderHighlightedCodeLines } from "../../composables/markdownCodeLines";

const props = withDefaults(
  defineProps<{
    /** Fenced code block language (e.g. "csharp", "typescript"). */
    language: string;
    /** Raw code content (the body between the opening and closing fence). */
    content: string;
    /** Optional file path metadata from the fence info string. */
    filePath?: string;
    /** Optional 1-based start line in the source file. */
    startLine?: number;
  }>(),
  {
    filePath: undefined,
    startLine: undefined,
  },
);

defineEmits<{
  (e: "openImage", src: string): void;
}>();

/**
 * HLJS-highlighted HTML. Falls back to the raw (escaped) content when the
 * language is empty or unknown — this matches `markdownEngine.ts:44`'s
 * behavior for the inline-text path.
 *
 * The escape pass is required because the content is rendered with
 * `v-html`; without it, the user could embed live HTML/JS into the chat
 * view. `hljs.highlight` already returns escaped HTML for non-tag
 * characters, so this only matters for the unknown-language fallback.
 */
const highlightedHtml = computed(() => {
  const escaped = props.content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (!props.language) return escaped;
  if (!hljs.getLanguage(props.language)) return escaped;
  return hljs.highlight(props.content, { language: props.language }).value;
});

const renderedHtml = computed(() => {
  const startLine = typeof props.startLine === "number" ? props.startLine : 1;
  return renderHighlightedCodeLines(highlightedHtml.value, true, startLine);
});
</script>

<template>
  <pre
    class="markdown-body code-block-view"
    :data-code-block-language="language || 'plain'"
    :data-code-block-file-path="filePath ?? null"
  ><code
    :class="language ? `hljs language-${language}` : 'plain'"
    v-html="renderedHtml"
  ></code></pre>
</template>

<style scoped>
.code-block-view {
  margin: 8px 0;
  padding: 12px 14px;
  background: var(--msg-code-bg, rgba(0, 0, 0, 0.04));
  border-radius: 6px;
  overflow-x: auto;
  font-family: var(--font-mono-block);
  font-size: 13px;
  line-height: 1.55;
}
.code-block-view :deep(.code-line) {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.code-block-view :deep(.line-number) {
  flex: 0 0 auto;
  min-width: 2.5em;
  text-align: right;
  color: var(--line-number-color, #6e7681);
  user-select: none;
  font-variant-numeric: tabular-nums;
}
.code-block-view :deep(.line-content) {
  flex: 1 1 auto;
  white-space: pre;
  word-break: normal;
  overflow-wrap: normal;
}
</style>
