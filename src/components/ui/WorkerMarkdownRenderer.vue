<script setup lang="ts">
// Thin Vue wrapper that renders markdown via the lute Web Worker.
//
// Use this in place of <MarkdownRenderer> for read-only paths where the
// content is large enough that the main-thread lute parse becomes a
// freeze risk (e.g. knowledge preview body when the document is opened
// in 'rendered' viewMode). Editing paths still go through BaseMarkdownEditor.
//
// Behaviour:
//   - On content change, aborts the previous in-flight request
//   - Renders a transient 'rendering…' placeholder while parsing
//   - Sets the resulting HTML only if the request was not aborted
//
// The component deliberately re-uses the same `markdown-rendered-search`
// class names that MarkdownRenderer emits, so existing CSS keeps applying.

import { onBeforeUnmount, ref, watch } from 'vue'
import { renderMarkdown } from '../../services/markdownWorkerClient'

const props = defineProps<{
  content: string
  /** When true, the renderer's own styling is suppressed (e.g. nested in a card). */
  bare?: boolean
}>()

const html = ref<string>('')
const rendering = ref(false)
let current: AbortController | null = null

async function render(content: string) {
  // Cancel any previous in-flight render before starting a new one.
  current?.abort()
  const controller = new AbortController()
  current = controller
  rendering.value = true
  try {
    const result = await renderMarkdown(content, { signal: controller.signal })
    if (!controller.signal.aborted) {
      html.value = result
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      // eslint-disable-next-line no-console
      console.error('[WorkerMarkdownRenderer] render failed', err)
      html.value = ''
    }
  } finally {
    if (current === controller) {
      rendering.value = false
    }
  }
}

watch(
  () => props.content,
  (next) => {
    if (next) void render(next)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  current?.abort()
  current = null
})
</script>

<template>
  <div
    class="worker-markdown-renderer vditor-ir"
    :class="{ 'is-rendering': rendering, 'is-bare': props.bare }"
    v-html="html"
  />
</template>

<style scoped>
.worker-markdown-renderer {
  position: relative;
  /* lute.Md2HTML produces the same inner HTML vditor IR uses, so the
     .vditor-ir class above lets the existing .preview-body :deep(.vditor-ir …)
     selectors keep applying (code blocks, lists, etc.). */
  padding: 12px 16px;
  /* Use Locus's theme tokens (defined in src/styles/app-global.css). The
     defaults here only kick in if the parent hasn't set them — body color
     (#a1a4ad dark / #5b6270 light) is intentionally dim, so without this
     override the markdown would inherit that dim color and look "gray". */
  color: var(--text-color);
  line-height: 1.55;
}
.worker-markdown-renderer.is-rendering {
  opacity: 0.6;
  transition: opacity 120ms ease-out;
}
/* Minimal typography for bare lute output. vditor would normally provide
   these via its own stylesheet; since the worker only ships the parser we
   re-declare the small set of selectors the body section actually uses. */
.worker-markdown-renderer :deep(h1),
.worker-markdown-renderer :deep(h2),
.worker-markdown-renderer :deep(h3),
.worker-markdown-renderer :deep(h4),
.worker-markdown-renderer :deep(h5),
.worker-markdown-renderer :deep(h6) {
  margin: 1em 0 0.5em;
  font-weight: 600;
  line-height: 1.25;
  color: var(--text-color);
}
.worker-markdown-renderer :deep(h1) { font-size: 1.6em; }
.worker-markdown-renderer :deep(h2) { font-size: 1.35em; }
.worker-markdown-renderer :deep(h3) { font-size: 1.15em; }
.worker-markdown-renderer :deep(p) { margin: 0.6em 0; }
.worker-markdown-renderer :deep(ul),
.worker-markdown-renderer :deep(ol) { padding-left: 1.6em; margin: 0.6em 0; }
.worker-markdown-renderer :deep(li) { margin: 0.2em 0; }
.worker-markdown-renderer :deep(blockquote) {
  margin: 0.6em 0;
  padding: 0.2em 0.8em;
  border-left: 3px solid var(--border-color);
  color: var(--text-secondary);
  background: transparent;
}
.worker-markdown-renderer :deep(code) {
  font-family: var(--font-mono-inline);
  font-size: 0.9em;
  padding: 0.1em 0.35em;
  background: var(--accent-soft, rgba(127,127,127,0.12));
  border-radius: 3px;
}
.worker-markdown-renderer :deep(pre) {
  margin: 0.6em 0;
  padding: 0.8em 1em;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  overflow-x: auto;
}
.worker-markdown-renderer :deep(pre code) {
  padding: 0;
  background: transparent;
  font-size: 0.85em;
}
.worker-markdown-renderer :deep(a) {
  color: var(--accent-color);
  text-decoration: underline;
}
.worker-markdown-renderer :deep(table) {
  border-collapse: collapse;
  margin: 0.6em 0;
}
.worker-markdown-renderer :deep(th),
.worker-markdown-renderer :deep(td) {
  border: 1px solid var(--border-color);
  padding: 0.3em 0.6em;
}
.worker-markdown-renderer :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border-color);
  margin: 1em 0;
}
.worker-markdown-renderer :deep(img) {
  max-width: 100%;
  height: auto;
}
</style>
