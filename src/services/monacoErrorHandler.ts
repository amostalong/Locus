// Centralized handling for noisy / recoverable Monaco errors that surface
// during editor initialization in @codingame/monaco-vscode-api 33.0.9.
//
// Why this exists
// ===============
// Monaco routes caught errors through `errorHandler.onUnexpectedError`,
// whose default handler is
//
//   setTimeout(() => { throw new Error(e.message + "\n\n" + e.stack); }, 0)
//
// (see node_modules/@codingame/monaco-vscode-api/vscode/src/vs/base/common/errors.js
// lines 6-16). The throw becomes an async uncaught exception that bubbles
// to `window.onerror`, but Locus's debugConsole patches `console.error`
// first, so the error reaches the Locus log via the `console.error` hook
// regardless of how `window` listeners are wired. Trying to suppress it
// from a `window.addEventListener('error')` listener is therefore useless
// — that listener never sees the error because the patched console hook
// consumes it before any window-level error event fires.
//
// The proper interception point is `setUnexpectedErrorHandler`, which
// monaco-vscode-api exports from `@codingame/monaco-vscode-api/monaco`.
// Installing a custom handler here runs BEFORE Monaco schedules its
// setTimeout throw, so we can silently drop the recognized fingerprints
// without ever letting them reach the console patch.
//
// Race being silenced: `MonarchModernTokensCollector.emit` calls
// `this._theme.match(...)` while `this._theme` is still undefined for
// the first few lines of any freshly-opened csharp model. Monaco's
// `safeTokenize` wrapper already catches the throw and falls back to
// `nullTokenizeEncoded`, so the editor stays usable — the offending lines
// just don't get syntax-highlighted until a later tokenization pass
// succeeds. Once the theme-defaults extension finishes registering
// themes (and the Monarch tokenizer re-binds), the race stops firing.
//
// Long-term fix is Roslyn textDocument/semanticTokens/full, which
// replaces Monarch entirely.

import { setUnexpectedErrorHandler } from "@codingame/monaco-vscode-api";

const MONARCH_RACE_FINGERPRINTS: ReadonlyArray<{
  messageContains: string;
  stackContains: string;
}> = [
  {
    // Background tokenization — fires once per fresh csharp line until
    // the theme binds. Most common case.
    messageContains: "Cannot read properties of undefined (reading 'match')",
    stackContains: "MonarchModernTokensCollector.emit",
  },
];

let installed = false;
let swallowCount = 0;

export function installMonacoErrorHandlers(): void {
  if (installed) return;
  installed = true;

  setUnexpectedErrorHandler((err: unknown) => {
    if (isMonarchRace(err)) {
      swallowCount++;
      return;
    }
    // Anything else: keep Monaco's default behavior (it will schedule a
    // setTimeout throw, which the Locus console hook will log normally).
    const e = err instanceof Error ? err : new Error(String(err));
    setTimeout(() => {
      throw e;
    }, 0);
  });
}

function isMonarchRace(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  const stack = err.stack ?? "";
  for (const fp of MONARCH_RACE_FINGERPRINTS) {
    if (msg.includes(fp.messageContains) && stack.includes(fp.stackContains)) {
      return true;
    }
  }
  return false;
}

/** Diagnostic helper — exposed so tests / debug panels can confirm the handler is alive. */
export function getMonarchRaceSwallowCount(): number {
  return swallowCount;
}
