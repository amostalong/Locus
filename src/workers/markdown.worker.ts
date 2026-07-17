// Markdown Web Worker — offloads lute.parse from the main thread.
//
// Lute is a GopherJS-compiled Go markdown parser shipped as a UMD bundle
// (`vditor/dist/js/lute/lute.min.js`). It is pure JS at runtime — no DOM
// dependencies — so it runs cleanly inside a Web Worker. The static import
// is converted to a raw text payload by Vite's `?raw` suffix and re-evaluated
// in this worker's global scope (the GopherJS prelude attaches `Lute` to
// `self` / `globalThis`, which is the worker's globalThis).
//
// Protocol (postMessage both directions):
//   main → worker: { id, op: 'render', content, hash }
//   worker → main: { id, html, elapsed } | { id, error }
//
// Cancellation is handled client-side via AbortSignal — the worker always
// completes its current parse, the client simply discards the result. This
// is intentional: cancelling a long lute.parse mid-flight in Go runtime is
// not safe, and dropping the work after it finishes is cheap.

import luteSource from 'vditor/dist/js/lute/lute.min.js?raw'

// Web Worker global is `self`. Make sure it's bound (it's the worker's
// own globalThis, but some bundlers/transpilers can strip the reference).
if (typeof self === 'undefined') {
  ;(globalThis as { self: typeof globalThis }).self = globalThis
}

// Indirect eval → executes in the global scope, not module scope. This is
// what makes the GopherJS prelude's `var Lute = ...` end up on globalThis.
const indirectEval: (src: string) => unknown = new Function(
  'src',
  'return eval(src)',
) as (src: string) => unknown
indirectEval(luteSource)

// GopherJS attaches the Lute class to the chosen global (self / global / window).
type LuteCtorType = { New: () => LuteInstance }
const g = globalThis as unknown as { Lute?: LuteCtorType }
const LuteCtor: LuteCtorType | undefined = g.Lute
if (!LuteCtor || typeof LuteCtor.New !== 'function') {
  throw new Error('markdown.worker: failed to extract Lute from lute.min.js')
}

interface LuteInstance {
  Md2HTML: (md: string) => string
  // Match vditor's setLute defaults so output is consistent with the main
  // thread's vditor path.
  SetSanitize: (v: boolean) => void
  SetHeadingAnchor: (v: boolean) => void
  SetEmojiSite: (v: string) => void
  SetAutoSpace: (v: boolean) => void
  SetToC: (v: boolean) => void
  SetFootnotes: (v: boolean) => void
  SetFixTermTypo: (v: boolean) => void
  SetRenderListStyle: (v: boolean) => void
  SetLinkBase: (v: string) => void
  SetLinkPrefix: (v: string) => void
  SetMark: (v: boolean) => void
  SetGFMAutoLink: (v: boolean) => void
}

let instance: LuteInstance | null = null
const cache = new Map<string, string>()
const CACHE_LIMIT = 100 // simple LRU-ish cap to keep memory bounded

function getInstance(): LuteInstance {
  if (instance) return instance
  const inst = LuteCtor!.New()
  // Mirror vditor's setLute defaults from
  // node_modules/vditor/src/ts/markdown/setLute.ts so worker output matches
  // what the main thread's vditor would produce.
  inst.SetHeadingAnchor(false)
  inst.SetAutoSpace(false)
  inst.SetToC(false)
  inst.SetFootnotes(false)
  inst.SetFixTermTypo(false)
  inst.SetRenderListStyle(true)
  inst.SetLinkBase('')
  inst.SetLinkPrefix('')
  inst.SetMark(true)
  inst.SetGFMAutoLink(true)
  inst.SetEmojiSite('https://cdn.jsdelivr.net/npm/vditor@latest')
  inst.SetSanitize(true)
  instance = inst
  return inst
}

function trimCache(): void {
  if (cache.size <= CACHE_LIMIT) return
  // Drop oldest entries (Map preserves insertion order).
  const overflow = cache.size - CACHE_LIMIT
  const keys = cache.keys()
  for (let i = 0; i < overflow; i++) {
    const k = keys.next().value
    if (k !== undefined) cache.delete(k)
  }
}

interface RenderRequest {
  id: number
  op: 'render'
  content: string
  hash: string
}

self.addEventListener('message', (e: MessageEvent<RenderRequest>) => {
  const { id, op, content, hash } = e.data
  if (op !== 'render') return
  const cached = cache.get(hash)
  if (cached !== undefined) {
    ;(self as unknown as Worker).postMessage({ id, html: cached, cached: true })
    return
  }
  try {
    const t0 = performance.now()
    const html = getInstance().Md2HTML(content)
    const elapsed = performance.now() - t0
    cache.set(hash, html)
    trimCache()
    ;(self as unknown as Worker).postMessage({ id, html, elapsed, cached: false })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})
