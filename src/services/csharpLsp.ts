import type { CodeAnalysisToolsConfig, CsharpLspStatus } from "../types";
import { ipcInvoke } from "./ipc";
import { getLocusRuntime, type RuntimeUnsubscribe } from "./locusRuntime";

export function csharpLspGetStatus(): Promise<CsharpLspStatus> {
  return ipcInvoke<CsharpLspStatus>("csharp_lsp_get_status", undefined, {
    operation: "csharpLspGetStatus",
    notify: false,
    throwOnError: true,
  });
}

export function csharpLspSetEnabled(value: boolean): Promise<CsharpLspStatus> {
  return ipcInvoke<CsharpLspStatus>(
    "csharp_lsp_set_enabled",
    { value },
    { operation: "csharpLspSetEnabled", notify: false, throwOnError: true },
  );
}

export function csharpLspRestart(): Promise<CsharpLspStatus> {
  return ipcInvoke<CsharpLspStatus>("csharp_lsp_restart", undefined, {
    operation: "csharpLspRestart",
    notify: false,
    throwOnError: true,
  });
}

export function codeAnalysisToolsGetConfig(): Promise<CodeAnalysisToolsConfig> {
  return ipcInvoke<CodeAnalysisToolsConfig>("code_analysis_tools_get_config", undefined, {
    operation: "codeAnalysisToolsGetConfig",
    notify: false,
    throwOnError: true,
  });
}

export function codeAnalysisToolsSetConfig(
  value: CodeAnalysisToolsConfig,
): Promise<CodeAnalysisToolsConfig> {
  return ipcInvoke<CodeAnalysisToolsConfig>(
    "code_analysis_tools_set_config",
    { value },
    { operation: "codeAnalysisToolsSetConfig", notify: false, throwOnError: true },
  );
}

export function subscribeCsharpLspStatus(
  handler: (payload: CsharpLspStatus) => void,
): Promise<RuntimeUnsubscribe> {
  return getLocusRuntime().subscribe<CsharpLspStatus>("csharp-lsp-status", handler);
}

/**
 * Generic bridge to the active Roslyn language server. Forwards a raw LSP
 * `method` + `params` payload to the Rust csharp_lsp backend, which
 * routes it through `LspClient::request` and returns the JSON-RPC
 * `result` value. Used by the Monaco editor to drive hover / definition
 * / references / completion against the running server.
 *
 * Resolves with the raw server response (already parsed by the IPC
 * transport). Rejects with a descriptive error when the feature is
 * disabled, the workspace is empty, or the server is still warming up.
 */
export function csharpLspBridgeRequest(
  method: string,
  params: unknown,
): Promise<unknown> {
  return ipcInvoke<unknown>(
    "csharp_lsp_bridge_request",
    { method, params: params ?? null },
    { operation: "csharpLspBridgeRequest", notify: false, throwOnError: true },
  );
}

/**
 * Push the current on-disk content of `path` to the Roslyn server.
 * The backend's `LspClient::sync_document` decides between didOpen
 * (first time) and didClose + didOpen (subsequent edits — Roslyn's
 * incremental sync handler is fragile on rangeless full-text
 * didChange, so the LspClient reopens the document each time).
 * Caller (EditorSync) should debounce so we don't fire on every
 * keystroke.
 */
export function csharpLspNotifyChange(path: string): Promise<void> {
  return ipcInvoke<void>("csharp_lsp_did_change", { path }, {
    operation: "csharpLspNotifyChange",
    notify: false,
    throwOnError: true,
  });
}

/**
 * Tell the Roslyn server that `path` is no longer open in the editor
 * (tab closed, model disposed). Mirrors the workspace-relative path
 * shape used by `csharpLspNotifyChange` — the backend normalizes it
 * to a `file://` URI on the wire.
 */
export function csharpLspNotifyClose(path: string): Promise<void> {
  return ipcInvoke<void>("csharp_lsp_did_close", { path }, {
    operation: "csharpLspNotifyClose",
    notify: false,
    throwOnError: true,
  });
}

/**
 * Returns the preprocessor symbols defined in the csproj that owns
 * `fileRelPath` (a workspace-relative, forward-slash path). Used by the
 * Monaco preprocessor dimming feature to determine which `#if` branches
 * are active *for the file actually being edited* — not the union of
 * every csproj in the workspace, which would leak unrelated asmdef
 * defines (e.g. `WEIXINMINIGAME` from a Wechat-only asmdef showing up
 * active in unrelated files).
 *
 * Pass `undefined` (or omit) to fall back to the workspace-union, used
 * when no file is open yet.
 *
 * This is the **csproj** path: it reads `<DefineConstants>` directly out
 * of the owning .csproj. It does not understand MSBuild `[Condition]`,
 * source-level `#define`, or asmdef `defineConstraints`. Kept as a
 * fallback for when the Roslyn probe is unavailable.
 */
export function getPreprocessorSymbols(
  fileRelPath?: string,
): Promise<string[]> {
  return ipcInvoke<string[]>(
    "get_preprocessor_symbols",
    { fileRelPath: fileRelPath ?? null },
    {
      operation: "getPreprocessorSymbols",
      notify: false,
      throwOnError: true,
    },
  );
}

/**
 * Returns the preprocessor symbols that Roslyn sees for `fileRelPath`,
 * by sending a `textDocument/completion` request to the running Roslyn
 * LSP server at a `#if` / `#elif` / `#define` line in the file. The
 * completion provider's preprocessor context returns the full symbol
 * table — csproj `<DefineConstants>` (with MSBuild `[Condition]` /
 * `$(Variable)` / `Choose/When/Otherwise` all resolved) plus every
 * source-level `#define` seen so far in the file — in a single RPC.
 *
 * **Why completion and not semantic tokens**: Roslyn classifies the
 * identifier inside `#if X` with the *same* token type as a regular
 * identifier in code (`UNITY_EDITOR` and `_rectTf` are both
 * `identifier`). The preprocessor keyword tokens like `if`/`else`/
 * `endif` get a dedicated `macro` semantic-token type, but the symbol
 * references don't. Completion at the directive context, on the
 * other hand, is exactly the "give-me-the-preprocessor-table" hook.
 *
 * Callers should treat rejections as "fall back to
 * getPreprocessorSymbols", not as a hard error — when the server is
 * still warming up the bridge rejects and we'd rather have a
 * degraded but not-broken dimming experience than break the editor.
 */
export function getPreprocessorSymbolsFromCompletion(
  fileRelPath: string,
): Promise<string[]> {
  return ipcInvoke<string[]>(
    "get_preprocessor_symbols_via_completion",
    { fileRelPath },
    {
      operation: "getPreprocessorSymbolsFromCompletion",
      notify: false,
      throwOnError: true,
    },
  );
}
