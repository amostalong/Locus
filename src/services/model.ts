import { ipcInvoke } from "./ipc";
import type {
  AgentModelPreference,
  ModelDefaults,
  CustomEndpoint,
  CustomProvider,
  CodexModelConfig,
  ModelCatalogResponse,
  ModelOption,
} from "../types";

export function getAgentModelPreferences(): Promise<Record<string, AgentModelPreference>> {
  return ipcInvoke<Record<string, AgentModelPreference>>("get_agent_model_preferences");
}

export function saveAgentModelPreference(
  agentId: string,
  modelId: string,
  effort: AgentModelPreference["effort"],
): Promise<void> {
  return ipcInvoke("save_agent_model_preference", { agentId, modelId, effort });
}

export function getModelDefaults(): Promise<ModelDefaults> {
  return ipcInvoke<ModelDefaults>("get_model_defaults");
}

export function saveModelDefaults(defaults: ModelDefaults): Promise<void> {
  return ipcInvoke("save_model_defaults", { defaults });
}

export function getCodexModelConfig(): Promise<CodexModelConfig> {
  return ipcInvoke<CodexModelConfig>("get_codex_model_config");
}

export function getCodexAvailableModels(): Promise<ModelOption[]> {
  return ipcInvoke<ModelOption[]>("get_codex_available_models");
}

export function saveCodexModelConfig(config: CodexModelConfig): Promise<void> {
  return ipcInvoke("save_codex_model_config", { config });
}

export function getLastModel(): Promise<string> {
  return ipcInvoke<string>("get_last_model");
}

export function saveLastModel(modelId: string): Promise<void> {
  return ipcInvoke("save_last_model", { modelId });
}

/**
 * Pin (or release, when `modelId == null`) a per-session model override.
 * Delegates to the `set_session_model` tauri command which writes to
 * `sessions.model_id` via `SessionStore::set_session_model_id`.
 */
export function setSessionModel(
  sessionId: string,
  modelId: string | null,
): Promise<void> {
  return ipcInvoke("set_session_model", { sessionId, modelId });
}

/**
 * Pin (or release, when `effort == null`) a per-session effort override.
 * Mirrors `setSessionModel` but for the reasoning-level column. The
 * caller is expected to have already validated the value against the
 * `EffortLevel` union.
 */
export function setSessionEffort(
  sessionId: string,
  effort: string | null,
): Promise<void> {
  return ipcInvoke("set_session_effort", { sessionId, effort });
}

export function getLastEffort(): Promise<string> {
  return ipcInvoke<string>("get_last_effort");
}

export function saveLastEffort(effort: string): Promise<void> {
  return ipcInvoke("save_last_effort", { effort });
}

export function getCodexFastMode(): Promise<boolean> {
  return ipcInvoke<boolean>("get_codex_fast_mode");
}

export function saveCodexFastMode(enabled: boolean): Promise<void> {
  return ipcInvoke("save_codex_fast_mode", { enabled });
}

export function getCustomProviders(): Promise<CustomProvider[]> {
  return ipcInvoke<CustomProvider[]>("get_custom_providers");
}

export function saveCustomProviders(providers: CustomProvider[]): Promise<void> {
  return ipcInvoke("save_custom_providers", { providers });
}

export function testCustomEndpoint(endpoint: CustomEndpoint): Promise<string> {
  return ipcInvoke<string>("test_custom_endpoint", { endpoint });
}

export function getWorkspaceModelOverride(): Promise<import("../types").WorkspaceModelOverride | null> {
  return ipcInvoke<import("../types").WorkspaceModelOverride | null>("get_workspace_model_override");
}

export function saveWorkspaceModelOverride(overrideData: import("../types").WorkspaceModelOverride): Promise<void> {
  return ipcInvoke("save_workspace_model_override", { overrideData });
}

export function disableWorkspaceModelOverride(): Promise<void> {
  return ipcInvoke("disable_workspace_model_override");
}

export function getModelCatalog(): Promise<ModelCatalogResponse> {
  return ipcInvoke<ModelCatalogResponse>("get_model_catalog");
}

export function refreshModelCatalog(): Promise<ModelCatalogResponse> {
  return ipcInvoke<ModelCatalogResponse>("refresh_model_catalog");
}
