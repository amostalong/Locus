import type {
  CodeAnalysisToolsConfig,
  CsharpCompileStatus,
  CsharpLspStatus,
  UnityNativeBrokerStatus,
  UnitySemanticState,
} from "../types";
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

export function unitySidecarCompilerGetStatus(): Promise<CsharpCompileStatus> {
  return ipcInvoke<CsharpCompileStatus>("unity_sidecar_compiler_get_status", undefined, {
    operation: "unitySidecarCompilerGetStatus",
    notify: false,
    throwOnError: true,
  });
}

export function unitySidecarCompilerSetEnabled(value: boolean): Promise<CsharpCompileStatus> {
  return ipcInvoke<CsharpCompileStatus>(
    "unity_sidecar_compiler_set_enabled",
    { value },
    { operation: "unitySidecarCompilerSetEnabled", notify: false, throwOnError: true },
  );
}

export function unityHotReloadSetEnabled(value: boolean): Promise<CsharpCompileStatus> {
  return ipcInvoke<CsharpCompileStatus>(
    "unity_hot_reload_set_enabled",
    { value },
    { operation: "unityHotReloadSetEnabled", notify: false, throwOnError: true },
  );
}

export interface HotReloadPreflight {
  connected: boolean;
  /** "debug" | "release" when readable; null when the editor is unreachable. */
  codeOptimization: string | null;
  /** Whether entering Play Mode reloads the domain (true = Unity default,
   * false = DisableDomainReload); null when unreadable / older plugin. */
  domainReloadOnPlay: boolean | null;
}

/** Enable-time check: the connected editor's Code Optimization, for the
 * Debug-mode gate the hot-reload toggles run before turning the feature on. */
export function unityHotReloadPreflight(): Promise<HotReloadPreflight> {
  return ipcInvoke<HotReloadPreflight>("unity_hot_reload_preflight", undefined, {
    operation: "unityHotReloadPreflight",
    notify: false,
    throwOnError: true,
  });
}

export interface CodeOptimizationResult {
  codeOptimization: string;
}

/** Switch the connected editor's Code Optimization to Debug (the auto-fix the
 * user confirms in the enable-time prompt). Triggers a Unity recompile. */
export function unityHotReloadSetCodeOptimizationDebug(): Promise<CodeOptimizationResult> {
  return ipcInvoke<CodeOptimizationResult>(
    "unity_hot_reload_set_code_optimization_debug",
    undefined,
    {
      operation: "unityHotReloadSetCodeOptimizationDebug",
      notify: false,
      throwOnError: true,
    },
  );
}

/** Switch the connected editor's Code Optimization to an explicit level
 * ("debug" | "release"), from the hot-reload popover dropdown. Triggers a
 * Unity recompile. */
export function unityHotReloadSetCodeOptimization(
  level: "debug" | "release",
): Promise<CodeOptimizationResult> {
  return ipcInvoke<CodeOptimizationResult>(
    "unity_hot_reload_set_code_optimization",
    { level },
    {
      operation: "unityHotReloadSetCodeOptimization",
      notify: false,
      throwOnError: true,
    },
  );
}

export interface PlayModeReloadResult {
  domainReloadOnPlay: boolean;
}

/** Set whether entering Play Mode reloads the domain (EditorSettings
 * enterPlayModeOptions / DisableDomainReload), from the hot-reload popover
 * toggle. Unlike the Code Optimization switch this does NOT trigger a Unity
 * recompile. */
export function unityHotReloadSetPlayModeReload(
  domainReload: boolean,
): Promise<PlayModeReloadResult> {
  return ipcInvoke<PlayModeReloadResult>(
    "unity_hot_reload_set_play_mode_reload",
    { domainReload },
    {
      operation: "unityHotReloadSetPlayModeReload",
      notify: false,
      throwOnError: true,
    },
  );
}

export function unityRecompileRun(): Promise<string> {
  return ipcInvoke<string>("unity_recompile_run", undefined, {
    operation: "unityRecompileRun",
    notify: false,
    throwOnError: true,
  });
}

export interface HotReloadSelfTestEvent {
  running: boolean;
  finished: boolean;
  line?: string | null;
  passed: number;
  failed: number;
}

export function unityHotReloadSelfTestRun(): Promise<void> {
  return ipcInvoke<void>("unity_hot_reload_selftest_run", undefined, {
    operation: "unityHotReloadSelfTestRun",
    notify: false,
    throwOnError: true,
  });
}

export function subscribeUnityHotReloadSelfTest(
  handler: (payload: HotReloadSelfTestEvent) => void,
): Promise<RuntimeUnsubscribe> {
  return getLocusRuntime().subscribe<HotReloadSelfTestEvent>("unity-hotreload-selftest", handler);
}

export type UnityStateProbeTier =
  | "disabled"
  | "inactive"
  | "passive"
  | "stack"
  | "cpu_only"
  | "inference"
  | "unsupported";

export interface UnityStateProbeStatus {
  enabled: boolean;
  supported: boolean;
  tier: UnityStateProbeTier;
  processId?: number | null;
  reloadSymbols: number;
  totalSymbols: number;
  lastPhase?: string | null;
  error?: string | null;
  updatedAtMs: number;
}

export function unityStateProbeGetStatus(): Promise<UnityStateProbeStatus> {
  return ipcInvoke<UnityStateProbeStatus>("get_unity_state_probe_status", undefined, {
    operation: "unityStateProbeGetStatus",
    notify: false,
    throwOnError: true,
  });
}

export function unityStateProbeSetEnabled(value: boolean): Promise<UnityStateProbeStatus> {
  return ipcInvoke<UnityStateProbeStatus>(
    "set_unity_state_probe_enabled",
    { value },
    { operation: "unityStateProbeSetEnabled", notify: false, throwOnError: true },
  );
}

export function unityStateProbeSelfTestRun(): Promise<void> {
  return ipcInvoke<void>("unity_state_probe_selftest_run", undefined, {
    operation: "unityStateProbeSelfTestRun",
    notify: false,
    throwOnError: true,
  });
}

export function unitySemanticStateGet(): Promise<UnitySemanticState> {
  return ipcInvoke<UnitySemanticState>("get_unity_semantic_state", undefined, {
    operation: "unitySemanticStateGet",
    notify: false,
    throwOnError: true,
  });
}

export function subscribeUnityStateProbeSelfTest(
  handler: (payload: HotReloadSelfTestEvent) => void,
): Promise<RuntimeUnsubscribe> {
  return getLocusRuntime().subscribe<HotReloadSelfTestEvent>("unity-state-probe-selftest", handler);
}

export function unityNativeBridgeGetEnabled(): Promise<boolean> {
  return ipcInvoke<boolean>("get_unity_native_bridge_enabled", undefined, {
    operation: "unityNativeBridgeGetEnabled",
    notify: false,
    throwOnError: true,
  });
}

export function unityNativeBridgeSetEnabled(value: boolean): Promise<boolean> {
  return ipcInvoke<boolean>(
    "set_unity_native_bridge_enabled",
    { value },
    { operation: "unityNativeBridgeSetEnabled", notify: false, throwOnError: true },
  );
}

export function unityNativeBrokerGetStatus(): Promise<UnityNativeBrokerStatus | null> {
  return ipcInvoke<UnityNativeBrokerStatus | null>("get_unity_native_broker_status", undefined, {
    operation: "unityNativeBrokerGetStatus",
    notify: false,
    throwOnError: true,
  });
}

export function unityNativeBridgeSelfTestRun(): Promise<void> {
  return ipcInvoke<void>("unity_native_bridge_selftest_run", undefined, {
    operation: "unityNativeBridgeSelfTestRun",
    notify: false,
    throwOnError: true,
  });
}

export function subscribeUnityNativeBridgeSelfTest(
  handler: (payload: HotReloadSelfTestEvent) => void,
): Promise<RuntimeUnsubscribe> {
  return getLocusRuntime().subscribe<HotReloadSelfTestEvent>(
    "unity-native-bridge-selftest",
    handler,
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

export function subscribeUnitySidecarCompilerStatus(
  handler: (payload: CsharpCompileStatus) => void,
): Promise<RuntimeUnsubscribe> {
  return getLocusRuntime().subscribe<CsharpCompileStatus>("csharp-compile-status", handler);
}
