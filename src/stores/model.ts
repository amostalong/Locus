import { ref, computed, watch } from "vue";
import { defineStore } from "pinia";
import { useAuthStore } from "./auth";
import { useProjectStore } from "./project";
import { pickPreferredModelId } from "./modelSelection";
import * as modelService from "../services/model";
import type {
  ModelOption,
  ModelDefaults,
  WorkspaceModelOverride,
  CustomProvider,
  CustomProviderModel,
  EffortLevel,
  CodexModelConfig,
  CodexTransportMode,
} from "../types";
import { filterVisibleModels } from "../config/providerVisibility";
import { modelSupportsFastMode } from "../utils/modelDisplay";

const CLAUDE_CONTEXT_1M = 1_000_000;
const CLAUDE_STANDARD_EFFORTS: EffortLevel[] = ["none", "low", "medium", "high", "max"];
const CLAUDE_XHIGH_EFFORTS: EffortLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];

const builtinModels: ModelOption[] = [
  {
    id: "openrouter/claude-fable-5",
    name: "Claude Fable 5[1m]",
    provider: "openrouter",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_XHIGH_EFFORTS,
  },
  {
    id: "openrouter/claude-opus-4.8",
    name: "Claude Opus 4.8[1m]",
    provider: "openrouter",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_XHIGH_EFFORTS,
    isDefault: true,
  },
  {
    id: "openrouter/claude-sonnet-5",
    name: "Claude Sonnet 5[1m]",
    provider: "openrouter",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_XHIGH_EFFORTS,
  },
  {
    id: "openrouter/claude-opus-4.6",
    name: "Claude Opus 4.6[1m]",
    provider: "openrouter",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_STANDARD_EFFORTS,
  },
  { id: "openrouter/glm-5", name: "GLM 5", provider: "openrouter" },
  { id: "openrouter/minimax-m2.5", name: "MiniMax M2.5", provider: "openrouter" },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5[1m]",
    provider: "anthropic",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_XHIGH_EFFORTS,
  },
  {
    id: "claude-opus-4.8",
    name: "Claude Opus 4.8[1m]",
    provider: "anthropic",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_XHIGH_EFFORTS,
    isDefault: true,
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5[1m]",
    provider: "anthropic",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_XHIGH_EFFORTS,
  },
  {
    id: "claude-opus-4.6",
    name: "Claude Opus 4.6[1m]",
    provider: "anthropic",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_STANDARD_EFFORTS,
  },
  {
    id: "claude_code/claude-fable-5",
    name: "Claude Fable 5[1m]",
    provider: "claude_code",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_XHIGH_EFFORTS,
  },
  {
    id: "claude_code/claude-opus-4.8[1m]",
    name: "Claude Opus 4.8[1m]",
    provider: "claude_code",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_XHIGH_EFFORTS,
    isDefault: true,
  },
  {
    id: "claude_code/claude-sonnet-5",
    name: "Claude Sonnet 5[1m]",
    provider: "claude_code",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_XHIGH_EFFORTS,
  },
  {
    id: "claude_code/claude-opus-4.6[1m]",
    name: "Claude Opus 4.6[1m]",
    provider: "claude_code",
    contextWindow: CLAUDE_CONTEXT_1M,
    supportedEfforts: CLAUDE_STANDARD_EFFORTS,
  },
];

const codexFallbackModels: ModelOption[] = [
  {
    id: "openai/gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai_codex",
    contextWindow: 353_400,
    defaultEffort: "low",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    additionalSpeedTiers: ["fast"],
    isDefault: true,
  },
  {
    id: "openai/gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "openai_codex",
    contextWindow: 353_400,
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    additionalSpeedTiers: ["fast"],
    isDefault: false,
  },
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai_codex",
    contextWindow: 353_400,
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    additionalSpeedTiers: ["fast"],
    isDefault: false,
  },
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    provider: "openai_codex",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    additionalSpeedTiers: ["fast"],
    isDefault: false,
  },
  {
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    provider: "openai_codex",
    defaultEffort: "medium",
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    additionalSpeedTiers: ["fast"],
    isDefault: false,
  },
];

const effortLevels: EffortLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];

/**
 * Canonical effort ordering from least to most expensive. Used by
 * `nearestEffort` to pick a graceful fallback when a session switch
 * (or a new model selection) drops the current effort from the
 * supported list. Without this, switching opus → sonnet on xhigh
 * would snap effort back to `low` and surprise the user.
 */
const EFFORT_ORDER: EffortLevel[] = effortLevels;

function effortIndex(level: EffortLevel): number {
  return EFFORT_ORDER.indexOf(level);
}

/**
 * Return the supported effort closest to `preferred` on the EFFORT_ORDER
 * axis. Ties go to the lower-cost option so we never silently escalate
 * the user to a more expensive model capability than they were on before.
 * Returns `undefined` if `supported` is empty.
 */
function nearestEffort(preferred: EffortLevel, supported: EffortLevel[]): EffortLevel | undefined {
  if (supported.length === 0) return undefined;
  if (supported.includes(preferred)) return preferred;
  const target = effortIndex(preferred);
  if (target < 0) return supported[0];
  // Walk outward from the preferred index, preferring the lower side on ties.
  let lo = target - 1;
  let hi = target + 1;
  while (lo >= 0 || hi < EFFORT_ORDER.length) {
    if (lo >= 0 && supported.includes(EFFORT_ORDER[lo])) return EFFORT_ORDER[lo];
    if (hi < EFFORT_ORDER.length && supported.includes(EFFORT_ORDER[hi])) return EFFORT_ORDER[hi];
    lo--;
    hi++;
  }
  return supported[0];
}
const customDefaultReasoningEfforts: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const legacyCustomDefaultReasoningEfforts: EffortLevel[] = ["low", "medium", "high", "max"];

function normalizeOpenAiReasoningModel(model: string): string {
  return model.trim().toLowerCase();
}

function isEffortLevel(value: string): value is EffortLevel {
  return effortLevels.includes(value as EffortLevel);
}

function normalizeEfforts(values?: EffortLevel[] | null): EffortLevel[] {
  if (!Array.isArray(values)) return [];
  return values.filter(isEffortLevel);
}

function normalizeCustomReasoningEfforts(values?: EffortLevel[] | null): EffortLevel[] {
  const normalized = normalizeEfforts(values).filter((value) => value !== "none");
  if (isSameEffortList(normalized, legacyCustomDefaultReasoningEfforts)) {
    return [...customDefaultReasoningEfforts];
  }
  return normalized.length > 0 ? normalized : [...customDefaultReasoningEfforts];
}

function isSameEffortList(a: EffortLevel[], b: EffortLevel[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function supportsOpenAiReasoningModel(model: string): boolean {
  const m = normalizeOpenAiReasoningModel(model);
  return m.includes("codex") || m.includes("gpt-5");
}

function openAiReasoningLevels(model: string): EffortLevel[] {
  const m = normalizeOpenAiReasoningModel(model);
  if (m.includes("gpt-5.6")) return ["low", "medium", "high", "xhigh", "max"];
  if (m.includes("gpt-5.5-pro") || m.includes("gpt-5.4-pro") || m.includes("gpt-5.2-pro")) return ["medium", "high"];
  if (m.includes("gpt-5-pro")) return ["high"];
  if (m.includes("gpt-5.1-codex-mini")) return ["medium", "high"];
  if (m.includes("codex")) return ["low", "medium", "high", "xhigh"];
  if (m.includes("gpt-5.5") || m.includes("gpt-5.4") || m.includes("gpt-5.2") || m.includes("gpt-5.1")) {
    return ["low", "medium", "high", "xhigh"];
  }
  if (m.includes("gpt-5")) return ["low", "medium", "high", "xhigh"];
  return [];
}

function normalizeCodexTransport(config?: Partial<CodexModelConfig> | null): CodexTransportMode {
  return config?.transport === "http" ? "http" : "websocket";
}

function formatCodexModelName(id: string, fallbackName?: string): string {
  const slug = id.startsWith("openai/") ? id.slice("openai/".length) : id;
  const parts = slug
    .trim()
    .toLowerCase()
    .split("-")
    .filter(Boolean);
  const formatPart = (part: string): string => {
    if (part === "gpt") return "GPT";
    if (part === "codex") return "Codex";
    if (part === "mini") return "Mini";
    if (part === "spark") return "Spark";
    if (part === "pro") return "Pro";
    if (/^\d/.test(part)) return part;
    return part.charAt(0).toUpperCase() + part.slice(1);
  };

  if (parts[0] === "gpt" && parts[1]) {
    const head = `GPT-${parts[1]}`;
    const tail = parts.slice(2).map(formatPart).join(" ");
    return tail ? `${head} ${tail}` : head;
  }

  const formatted = parts.map(formatPart).join(" ");
  return formatted || fallbackName?.trim() || id;
}

function normalizeCodexModels(models?: ModelOption[] | null): ModelOption[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const normalized: ModelOption[] = [];
  for (const model of models) {
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id.startsWith("openai/") || seen.has(id)) continue;
    seen.add(id);
    const name = formatCodexModelName(id, model.name);
    normalized.push({
      ...model,
      id,
      name,
      provider: "openai_codex",
      supportedEfforts: normalizeEfforts(model.supportedEfforts),
    });
  }
  return normalized;
}

export function customModelId(provider: CustomProvider, model: CustomProviderModel): string {
  return `custom/${provider.id}/${model.id}`;
}

function customModelDisplayName(provider: CustomProvider, model: CustomProviderModel): string {
  if (provider.models.length <= 1) return provider.name;
  return `${provider.name} / ${model.name}`;
}

export const useModelStore = defineStore("model", () => {
  const authStore = useAuthStore();
  const projectStore = useProjectStore();

  const customProviders = ref<CustomProvider[]>([]);
  const codexRemoteModels = ref<ModelOption[]>([]);
  const codexTransport = ref<CodexTransportMode>("websocket");
  const codexFastMode = ref(false);
  const selectedModelId = ref("");
  const lastModelId = ref("");
  const effort = ref<EffortLevel>("high");
  const defaultEffort = ref<EffortLevel>("high");
  const hasUserDefaultEffort = ref(false);
  const modelDefaults = ref<ModelDefaults>({ mainModel: "", planModel: "", subagentModels: {} });
  const workspaceOverride = ref<WorkspaceModelOverride | null>(null);
  // -- Per-session model override --
  // The active session id is owned by the chat store. We mirror it here so
  // `effectiveModelId` can be a pure computed and avoid a chat→model import
  // cycle. The chat store calls `setActiveSessionId(...)` whenever the
  // session changes.
  const activeSessionId = ref<string | null>(null);
  // sessionId -> modelId. An entry is only present when the user explicitly
  // pinned a model to that session. Missing entry == session follows global.
  const sessionModelOverrides = ref<Map<string, string>>(new Map());
  // sessionId -> EffortLevel. Mirrors `sessionModelOverrides` for the
  // reasoning level. Pinned sessions carry their own effort; non-pinned
  // sessions fall back to the global `effort` ref.
  const sessionEffortOverrides = ref<Map<string, EffortLevel>>(new Map());
  let effortPersistenceReady = false;

  // -- Getters --

  const effectiveModelDefaults = computed<ModelDefaults>(() => {
    const ov = workspaceOverride.value;
    if (ov?.enabled) {
      return {
        mainModel: ov.mainModel || modelDefaults.value.mainModel,
        planModel: ov.planModel || modelDefaults.value.planModel,
        subagentModels: { ...modelDefaults.value.subagentModels, ...ov.subagentModels },
      };
    }
    return modelDefaults.value;
  });

  const codexModels = computed<ModelOption[]>(() =>
    codexRemoteModels.value.length > 0 ? codexRemoteModels.value : codexFallbackModels
  );

  const allModels = computed<ModelOption[]>(() => {
    const customs: ModelOption[] = customProviders.value.flatMap((provider) =>
      provider.models.map((model) => ({
        id: customModelId(provider, model),
        name: customModelDisplayName(provider, model),
        provider: "custom" as const,
        contextWindow: model.contextLength || undefined,
        supportedEfforts:
          model.reasoningParamFormat === "none"
            ? []
            : normalizeCustomReasoningEfforts(model.supportedReasoningEfforts),
        customProviderId: provider.id,
        customProviderName: provider.name,
        customModelName: model.name || provider.name,
      })),
    );
    // Claude Code CLI models are opt-in: they only join the list after the
    // user explicitly enables them in model configuration.
    const models = [...builtinModels, ...codexModels.value, ...customs].filter(
      (m) => m.provider !== "claude_code" || modelDefaults.value.claudeCodeEnabled === true,
    );
    return filterVisibleModels(models);
  });

  const availableModels = computed(() => {
    const providers = new Set<string>();
    if (authStore.hasApiKey) providers.add("openrouter");
    if (authStore.isAuthenticated) providers.add("anthropic");
    if (authStore.claudeCodeAvailable) providers.add("claude_code");
    if (authStore.codexAuthenticated) providers.add("openai_codex");
    providers.add("custom");
    return allModels.value.filter((m) => providers.has(m.provider));
  });

  /** Resolve a `custom/...` model id to its provider + model config. Accepts
   *  the legacy single-segment form (first model of the provider). */
  function findCustomModel(
    modelId: string,
  ): { provider: CustomProvider; model: CustomProviderModel } | null {
    if (!modelId.startsWith("custom/")) return null;
    const rest = modelId.slice("custom/".length);
    const slash = rest.indexOf("/");
    const providerId = slash >= 0 ? rest.slice(0, slash) : rest;
    const modelRowId = slash >= 0 ? rest.slice(slash + 1) : null;
    const provider = customProviders.value.find((p) => p.id === providerId);
    if (!provider) return null;
    const model = modelRowId
      ? provider.models.find((m) => m.id === modelRowId)
      : provider.models[0];
    return model ? { provider, model } : null;
  }

  /**
   * The model id that should be used for the *current* session. Resolves in
   * priority order:
   *   1. per-session override (if the active session has one)
   *   2. global `selectedModelId`
   * Plan mode and compact callers should read this — never
   * `selectedModelId` directly — so that pinned sessions stay pinned.
   */
  const effectiveModelId = computed<string>(() => {
    const sid = activeSessionId.value;
    if (sid) {
      const override = sessionModelOverrides.value.get(sid);
      if (override) return override;
    }
    return selectedModelId.value;
  });

  /**
   * `true` when the active session has a per-session override and so its
   * model is decoupled from the global `selectedModelId`. UI uses this to
   * surface a "session-pinned" badge in the model selector.
   */
  const isSessionModelPinned = computed<boolean>(() => {
    const sid = activeSessionId.value;
    if (!sid) return false;
    return sessionModelOverrides.value.has(sid);
  });

  /**
   * The effort (reasoning level) the *current* session should use. Resolves
   * in priority order:
   *   1. per-session override (if the active session has one)
   *   2. global `effort` ref
   * Mirrors `effectiveModelId`. Callers (chat composer, outgoing request
   * payloads) should read this — never `effort.value` directly.
   */
  const effectiveEffort = computed<EffortLevel>(() => {
    const sid = activeSessionId.value;
    if (sid) {
      const override = sessionEffortOverrides.value.get(sid);
      if (override) return override;
    }
    return effort.value;
  });

  /**
   * `true` when the active session has a per-session effort override.
   * UI uses this to surface a separate "effort-pinned" badge so the user
   * knows switching effort in the composer only affects this session.
   */
  const isSessionEffortPinned = computed<boolean>(() => {
    const sid = activeSessionId.value;
    if (!sid) return false;
    return sessionEffortOverrides.value.has(sid);
  });

  // All per-model derived state (selectedModelOption, availableEfforts, ...)
  // MUST be computed from `effectiveModelId` rather than `selectedModelId`.
  // Otherwise switching to a pinned session (different model) would leave
  // the effort selector showing the wrong levels — e.g. opus `xhigh` would
  // still be offered for a pinned sonnet session that does not support it.

  const selectedCustomModel = computed(() => findCustomModel(effectiveModelId.value));

  const selectedModelOption = computed<ModelOption | null>(() =>
    allModels.value.find((model) => model.id === effectiveModelId.value) ?? null
  );

  function modelSupportsCodexFastMode(modelId: string): boolean {
    const model = allModels.value.find((candidate) => candidate.id === modelId);
    return model ? modelSupportsFastMode(model) : false;
  }

  const codexFastModeAvailable = computed(() =>
    modelSupportsCodexFastMode(effectiveModelId.value)
  );

  const effectiveCodexFastMode = computed(() =>
    codexFastMode.value && codexFastModeAvailable.value
  );

  const selectedOpenAiReasoningModel = computed<string | null>(() => {
    const selected = effectiveModelId.value;
    if (selected.startsWith("openai/")) {
      return selected.slice("openai/".length);
    }
    const custom = selectedCustomModel.value;
    if (custom && custom.provider.apiFormat === "openai_responses") {
      return custom.model.apiModel;
    }
    return null;
  });

  // Returns the effort levels supported by the current model, sorted from
  // most expensive (`max`) to least expensive (`none`). The menu renders
  // the array in order, so reversing the source keeps the dropdown
  // high-to-low — matching how the model stores effort (e.g. opus 4.8
  // advertises CLAUDE_XHIGH_EFFORTS in low→high order, which we flip
  // before exposing to the UI).
  function sortEffortsDescending(levels: EffortLevel[]): EffortLevel[] {
    if (levels.length <= 1) return levels;
    const rank = new Map(EFFORT_ORDER.map((level, index) => [level, index]));
    return [...levels].sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0));
  }

  const availableEfforts = computed<EffortLevel[]>(() => {
    const m = effectiveModelId.value.toLowerCase();
    if (effectiveModelId.value.startsWith("custom/")) {
      const custom = selectedCustomModel.value;
      if (!custom || custom.model.reasoningParamFormat === "none") return [];
      return sortEffortsDescending(
        normalizeCustomReasoningEfforts(custom.model.supportedReasoningEfforts),
      );
    }
    const catalogEfforts = selectedModelOption.value?.supportedEfforts ?? [];
    if (catalogEfforts.length > 0) return sortEffortsDescending(catalogEfforts);
    if (m.includes("claude")) {
      return sortEffortsDescending(["none", "low", "medium", "high"]);
    }
    const openAiModel = selectedOpenAiReasoningModel.value;
    if (!openAiModel || !supportsOpenAiReasoningModel(openAiModel)) return [];
    return sortEffortsDescending(openAiReasoningLevels(openAiModel));
  });

  const effortSupported = computed(() => availableEfforts.value.length > 0);

  // -- Internal watchers (model-domain only) --

  function clampEffortForSelectedModel(level: EffortLevel): EffortLevel {
    const levels = availableEfforts.value;
    if (levels.length > 0 && !levels.includes(level)) {
      // Prefer the *closest* effort that the new model supports, not
      // `levels[0]`. This avoids snapping effort back to "low" every time
      // the user switches between two pinned sessions that share most but
      // not all effort levels (e.g. opus has xhigh, sonnet does not —
      // switching opus → sonnet should drop one step, not reset).
      return nearestEffort(level, levels) ?? levels[0];
    }
    return level;
  }

  // Clamp effort when available levels change — covers:
  //   - user picks a different model in the selector
  //   - user switches to a pinned session whose model supports a different
  //     effort set than the previous model
  // The clamp prefers the nearest supported level over a hard reset so
  // the user does not see their effort snap back to `low` on every
  // session switch. The clamp writes back to the *same* source the
  // current effort came from — session override if pinned, otherwise the
  // global `effort` ref — so we don't leak per-session state into global
  // and vice versa.
  watch(availableEfforts, (levels) => {
    const current = effectiveEffort.value;
    if (levels.length > 0 && !levels.includes(current)) {
      const next = nearestEffort(current, levels) ?? levels[0];
      if (next === current) return;
      const sid = activeSessionId.value;
      if (sid && sessionEffortOverrides.value.has(sid)) {
        // Update the session override in-place without persisting —
        // clamping is a local adjustment, not a user choice, so we do
        // not write back to the backend.
        const nextMap = new Map(sessionEffortOverrides.value);
        nextMap.set(sid, next);
        sessionEffortOverrides.value = nextMap;
      } else if (next !== effort.value) {
        effort.value = next;
      }
    }
  }, { immediate: true });

  watch(defaultEffort, (level) => {
    if (!effortPersistenceReady) return;
    Promise.resolve()
      .then(() => modelService.saveLastEffort(level))
      .catch((e: unknown) => console.warn("[model] save_last_effort:", e));
  });

  // Keep the selector valid when provider availability changes.
  watch(availableModels, (models) => {
    if (models.length === 0) {
      selectedModelId.value = "";
      return;
    }

    if (selectedModelId.value && models.some((m) => m.id === selectedModelId.value)) {
      return;
    }

    const next = pickPreferredModelId(models, effectiveModelDefaults.value, lastModelId.value);
    if (next) selectedModelId.value = next;
  }, { immediate: true });

  // Reload workspace model override when working dir changes
  watch(() => projectStore.workingDir, () => {
    void loadWorkspaceDefaults();
  });

  // Re-evaluate model selection when workspace override changes
  watch(workspaceOverride, () => {
    resolveSelectedModel(true);
  });


  // -- Actions --

  async function loadModelDefaults() {
    try {
      modelDefaults.value = await modelService.getModelDefaults();
    } catch { /* ignore */ }
  }

  async function loadLastModel() {
    try {
      const saved = await modelService.getLastModel();
      lastModelId.value = saved || "";
    } catch { /* ignore */ }
  }

  async function loadLastEffort() {
    effortPersistenceReady = false;
    try {
      const saved = await modelService.getLastEffort();
      if (isEffortLevel(saved)) {
        hasUserDefaultEffort.value = true;
        defaultEffort.value = saved;
        effort.value = clampEffortForSelectedModel(saved);
      }
    } catch { /* ignore */ }
    effortPersistenceReady = true;
  }

  async function loadCodexFastMode() {
    try {
      codexFastMode.value = await modelService.getCodexFastMode();
    } catch {
      codexFastMode.value = false;
    }
  }

  async function loadCustomProviders() {
    try {
      customProviders.value = await modelService.getCustomProviders();
    } catch { /* ignore */ }
  }

  async function loadCodexModelConfig() {
    try {
      codexTransport.value = normalizeCodexTransport(await modelService.getCodexModelConfig());
    } catch {
      codexTransport.value = "websocket";
    }
  }

  async function loadCodexAvailableModels() {
    if (!authStore.codexAuthenticated) {
      codexRemoteModels.value = [];
      return;
    }
    try {
      codexRemoteModels.value = normalizeCodexModels(await modelService.getCodexAvailableModels());
    } catch (e: unknown) {
      console.warn("[model] get_codex_available_models:", e);
      codexRemoteModels.value = [];
    }
  }

  function resolveSelectedModel(force = false) {
    const models = availableModels.value;
    if (models.length === 0) {
      selectedModelId.value = "";
      return;
    }

    if (!force && selectedModelId.value && models.some((m) => m.id === selectedModelId.value)) {
      return;
    }

    const next = pickPreferredModelId(models, effectiveModelDefaults.value, lastModelId.value);
    if (next) selectedModelId.value = next;
  }

  function rememberLastModel(id: string) {
    lastModelId.value = id;
    modelService.saveLastModel(id).catch((e: unknown) => console.warn("[model] save_last_model:", e));
  }

  function selectModel(id: string) {
    selectedModelId.value = id;
    rememberLastModel(id);
  }

  /**
   * Called by the chat store whenever the active session changes. Pushing
   * the id into the model store lets `effectiveModelId` resolve without the
   * model store needing to import the chat store (avoids a setup-time
   * circular dependency between the two pinia stores).
   */
  function setActiveSessionId(sid: string | null) {
    activeSessionId.value = sid;
  }

  /**
   * Set or clear a per-session model override in the local map. Does NOT
   * touch `selectedModelId` or `lastModelId` — the override is purely
   * session-scoped, so changing it leaves the global selection intact for
   * other sessions.
   *
   * `modelId == null` removes the entry (session follows global again).
   * Pass an empty string to also clear (treated the same as null).
   */
  function applySessionModel(sid: string, modelId: string | null) {
    const next = new Map(sessionModelOverrides.value);
    const trimmed = typeof modelId === "string" ? modelId.trim() : "";
    if (!trimmed) {
      next.delete(sid);
    } else {
      next.set(sid, trimmed);
    }
    sessionModelOverrides.value = next;
  }

  /**
   * Bulk hydrate session overrides at app startup. Called after
   * `listSessions` returns — the chat store iterates the summaries and
   * pushes each `modelId` here so subsequent reads of `effectiveModelId`
   * are synchronous.
   */
  function hydrateSessionOverrides(entries: Array<{ sessionId: string; modelId: string | null }>) {
    const next = new Map<string, string>();
    for (const { sessionId, modelId } of entries) {
      if (typeof modelId === "string" && modelId.trim()) {
        next.set(sessionId, modelId.trim());
      }
    }
    sessionModelOverrides.value = next;
  }

  /**
   * Pin a model to the active session and persist to the backend. Does NOT
   * touch the global `selectedModelId` / `lastModelId` — sessions that are
   * not pinned should keep following the global selection.
   */
  async function selectSessionModel(modelId: string) {
    const sid = activeSessionId.value;
    if (!sid) {
      // No active session: fall back to global select to keep current
      // behavior (last-resort path; the composer should normally be hidden
      // when there is no active session).
      selectModel(modelId);
      return;
    }
    const trimmed = modelId.trim();
    if (!trimmed) return;
    applySessionModel(sid, trimmed);
    try {
      await modelService.setSessionModel(sid, trimmed);
    } catch (e: unknown) {
      console.warn("[model] set_session_model:", e);
    }
  }

  /**
   * Set or clear a per-session effort override in the local map. Does NOT
   * touch `effort` / `defaultEffort` / `lastEffort` — the override is
   * purely session-scoped, so changing it leaves the global effort
   * intact for other sessions.
   *
   * `level == null` removes the entry (session follows global again).
   * Invalid (non-`EffortLevel`) values are ignored to keep the map
   * well-typed even if the backend returns a stale or unknown level.
   */
  function applySessionEffort(sid: string, level: EffortLevel | null) {
    const next = new Map(sessionEffortOverrides.value);
    if (level === null) {
      next.delete(sid);
    } else if (isEffortLevel(level)) {
      next.set(sid, level);
    }
    sessionEffortOverrides.value = next;
  }

  /**
   * Bulk hydrate per-session effort overrides at app startup. Mirrors
   * `hydrateSessionOverrides`. Invalid levels are dropped (the session
   * falls back to the global effort).
   */
  function hydrateSessionEfforts(entries: Array<{ sessionId: string; effort: string | null }>) {
    const next = new Map<string, EffortLevel>();
    for (const { sessionId, effort } of entries) {
      if (typeof effort === "string" && isEffortLevel(effort)) {
        next.set(sessionId, effort);
      }
    }
    sessionEffortOverrides.value = next;
  }

  /**
   * Pin an effort level to the active session and persist to the backend.
   * Does NOT touch the global `effort` / `lastEffort` — sessions that are
   * not pinned should keep following the global effort. The clamped value
   * (to the nearest supported level) is what gets persisted so the
   * backend never stores an effort the model cannot satisfy.
   */
  async function selectSessionEffort(level: EffortLevel) {
    if (!isEffortLevel(level)) return;
    const sid = activeSessionId.value;
    if (!sid) {
      // No active session: fall back to global select.
      selectEffort(level);
      return;
    }
    const clamped = clampEffortForSelectedModel(level);
    applySessionEffort(sid, clamped);
    try {
      await modelService.setSessionEffort(sid, clamped);
    } catch (e: unknown) {
      console.warn("[model] set_session_effort:", e);
    }
  }

  function selectEffort(level: EffortLevel) {
    if (!isEffortLevel(level)) return;
    // When the active session has its own effort pinned, the user's
    // choice belongs to that session — do not write to the global
    // `effort` / `defaultEffort` ref, which would leak across sessions.
    const sid = activeSessionId.value;
    if (sid && sessionEffortOverrides.value.has(sid)) {
      // Fire-and-forget; keep the call signature synchronous so
      // `ModelEffortSelector` can treat the click as instant.
      void selectSessionEffort(level);
      return;
    }
    hasUserDefaultEffort.value = true;
    defaultEffort.value = level;
    effort.value = clampEffortForSelectedModel(level);
  }

  function selectCodexFastMode(enabled: boolean) {
    codexFastMode.value = enabled;
    modelService.saveCodexFastMode(enabled)
      .catch((e: unknown) => console.warn("[model] save_codex_fast_mode:", e));
  }

  function codexFastModeForModel(modelId: string): boolean {
    return codexFastMode.value && modelSupportsCodexFastMode(modelId);
  }

  function applyContextEffort(level: EffortLevel | null | undefined) {
    const normalized = typeof level === "string" && isEffortLevel(level) ? level : "none";
    effort.value = clampEffortForSelectedModel(normalized);
  }

  function restoreDefaultEffort() {
    applyContextEffort(defaultEffort.value);
  }

  function applyModelDefaults(defaults: ModelDefaults) {
    modelDefaults.value = defaults;
  }

  async function loadWorkspaceDefaults() {
    try {
      workspaceOverride.value = await modelService.getWorkspaceModelOverride();
    } catch {
      workspaceOverride.value = null;
    }
  }

  async function saveWorkspaceOverride(data: WorkspaceModelOverride) {
    await modelService.saveWorkspaceModelOverride(data);
    workspaceOverride.value = data;
    resolveSelectedModel(true);
  }

  async function disableWorkspaceOverride() {
    await modelService.disableWorkspaceModelOverride();
    workspaceOverride.value = null;
    resolveSelectedModel(true);
  }

  function applyCustomProviders(providers: CustomProvider[]) {
    customProviders.value = providers;
  }

  function applyCodexModelConfig(config?: Partial<CodexModelConfig> | null) {
    codexTransport.value = normalizeCodexTransport(config);
  }

  return {
    customProviders,
    codexRemoteModels,
    codexTransport,
    codexFastMode,
    selectedModelId,
    lastModelId,
    effort,
    defaultEffort,
    hasUserDefaultEffort,
    modelDefaults,
    workspaceOverride,
    effectiveModelDefaults,
    allModels,
    availableModels,
    codexModels,
    selectedCustomModel,
    findCustomModel,
    selectedOpenAiReasoningModel,
    effectiveModelId,
    isSessionModelPinned,
    effectiveEffort,
    isSessionEffortPinned,
    codexFastModeAvailable,
    effectiveCodexFastMode,
    availableEfforts,
    effortSupported,
    loadModelDefaults,
    loadLastModel,
    loadLastEffort,
    loadCodexFastMode,
    loadCustomProviders,
    loadCodexModelConfig,
    loadCodexAvailableModels,
    resolveSelectedModel,
    selectModel,
    setActiveSessionId,
    applySessionModel,
    hydrateSessionOverrides,
    selectSessionModel,
    applySessionEffort,
    hydrateSessionEfforts,
    selectSessionEffort,
    selectEffort,
    selectCodexFastMode,
    codexFastModeForModel,
    applyContextEffort,
    restoreDefaultEffort,
    applyModelDefaults,
    loadWorkspaceDefaults,
    saveWorkspaceOverride,
    disableWorkspaceOverride,
    applyCustomProviders,
    applyCodexModelConfig,
  };
});
