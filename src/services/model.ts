import { ipcInvoke } from "./ipc";
import type { ModelDefaults, CustomEndpoint, CodexModelConfig, ModelOption } from "../types";

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

export function getLastEffort(): Promise<string> {
  return ipcInvoke<string>("get_last_effort");
}

export function saveLastEffort(effort: string): Promise<void> {
  return ipcInvoke("save_last_effort", { effort });
}

export function getCustomEndpoints(): Promise<CustomEndpoint[]> {
  return ipcInvoke<CustomEndpoint[]>("get_custom_endpoints");
}

export function saveCustomEndpoints(endpoints: CustomEndpoint[]): Promise<void> {
  return ipcInvoke("save_custom_endpoints", { endpoints });
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
