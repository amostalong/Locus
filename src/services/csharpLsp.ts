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
