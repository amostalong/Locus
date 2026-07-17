// Main-thread client for the markdown Web Worker.
//
// Why this exists: see `Locus/src/workers/markdown.worker.ts`. The worker
// owns a lute instance and answers `render(content)` calls off the main
// thread. This client is a thin Promise wrapper that:
//   - Lazily instantiates a single worker
//   - Correlates request/response by monotonic id
//   - Wires AbortSignal to in-flight requests
//   - Recovers from worker crashes (logs and rebuilds on next call)
//
// Intentionally NOT exported for unrelated markdown paths yet — only the
// knowledge preview integrates this in the first rollout. Keep the surface
// area small until the foundation is proven in production.

import MarkdownWorker from '../workers/markdown.worker?worker'

interface PendingRequest {
  resolve: (html: string) => void
  reject: (err: Error) => void
}

let worker: Worker | null = null
const pending = new Map<number, PendingRequest>()
let nextId = 0

function djb2Hash(s: string): string {
  // Cheap non-cryptographic hash. The worker re-runs lute for cache misses,
  // so collisions just mean an extra parse — never a correctness issue.
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return `${h.toString(36)}:${s.length}`
}

function getWorker(): Worker {
  if (worker) return worker
  const w = new MarkdownWorker()
  w.addEventListener('message', (e: MessageEvent) => {
    const { id, html, error } = e.data as { id: number; html?: string; error?: string }
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (error) {
      p.reject(new Error(`markdownWorker: ${error}`))
    } else {
      p.resolve(html ?? '')
    }
  })
  w.addEventListener('error', (e) => {
    // Reject everyone; next call will rebuild the worker.
    const err = new Error(`markdownWorker crashed: ${e.message ?? 'unknown'}`)
    for (const [, p] of pending) p.reject(err)
    pending.clear()
    worker?.terminate()
    worker = null
  })
  worker = w
  return w
}

export interface RenderMarkdownOptions {
  /**
   * When the signal aborts, the in-flight request is rejected with
   * `DOMException('aborted', 'AbortError')`. The worker is NOT asked to
   * stop mid-parse (lute has no cancellation hook) — the result, if it
   * arrives after abort, is dropped by the client.
   */
  signal?: AbortSignal
}

/**
 * Render markdown to sanitized HTML via the lute Web Worker.
 *
 * Resolves with the HTML string. Throws on parse error or worker crash.
 */
export function renderMarkdown(
  content: string,
  options: RenderMarkdownOptions = {},
): Promise<string> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('aborted', 'AbortError'))
  }
  const w = getWorker()
  const id = nextId++
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const cleanup = () => pending.delete(id)
    options.signal?.addEventListener('abort', () => {
      cleanup()
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
    w.postMessage({ id, op: 'render', content, hash: djb2Hash(content) })
  })
}
