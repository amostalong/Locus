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
