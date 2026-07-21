import type { ModelOption } from "../types";

export interface ModelSelectorGroup {
  /** Unique v-for key: the provider id, or `custom:<provider id>`. */
  key: string;
  /** Underlying provider ("custom" for every custom-provider group). */
  provider: string;
  label: string;
  models: ModelOption[];
}

/**
 * Pick a stable sort key for the model list. Mirrors the label the user
 * actually sees in the dropdown — `customModelName` for custom providers
 * (the section header already names the provider, so the entry is
 * prefix-free), otherwise the raw `name` field. `localeCompare` keeps
 * the ordering stable across the catalogs the builtin providers ship
 * with (Claude, GLM, GPT, …).
 */
function modelSortKey(model: ModelOption): string {
  if (model.provider === "custom" && model.customModelName) {
    return model.customModelName;
  }
  return model.name;
}

/**
 * Group models for the selector dropdowns. Built-in providers each form one
 * section; custom models form one section per custom provider (mirroring the
 * subscription-account groups). The *final* group order is decided by the
 * section label — `providerLabels[provider]` for built-ins, the user-chosen
 * `customProviderName` for custom accounts. This keeps the user in control:
 * renaming a custom account "Work Provider" slides it into the right slot
 * without touching code, and OpenRouter no longer needs to be hand-pinned
 * to the top of the array.
 */
export function groupModelsForSelector(
  models: ModelOption[],
  providerOrder: readonly string[],
  providerLabels: Record<string, string>,
): ModelSelectorGroup[] {
  const byProvider = new Map<string, ModelOption[]>();
  for (const model of models) {
    const list = byProvider.get(model.provider) || [];
    list.push(model);
    byProvider.set(model.provider, list);
  }

  // `providerOrder` is only used to pick which built-in providers are
  // visible (`claude_code` is filtered out in production). Make sure
  // `custom` is included so user-defined accounts always render.
  const allProviders = providerOrder.includes("custom")
    ? providerOrder
    : [...providerOrder, "custom"];

  const groups: ModelSelectorGroup[] = [];
  for (const provider of allProviders) {
    const providerModels = byProvider.get(provider);
    if (!providerModels || providerModels.length === 0) continue;

    if (provider !== "custom") {
      // Sort a copy so we don't mutate the upstream `allModels` array
      // (Pinia mutations outside a store action are a debugging hazard).
      const sorted = [...providerModels].sort((a, b) =>
        modelSortKey(a).localeCompare(modelSortKey(b)),
      );
      groups.push({
        key: provider,
        provider,
        label: providerLabels[provider] || provider,
        models: sorted,
      });
      continue;
    }

    const customGroups = new Map<string, ModelSelectorGroup>();
    for (const model of providerModels) {
      const id = model.customProviderId || "";
      const key = `custom:${id}`;
      let group = customGroups.get(key);
      if (!group) {
        group = {
          key,
          provider,
          label: model.customProviderName || providerLabels[provider] || provider,
          models: [],
        };
        customGroups.set(key, group);
        groups.push(group);
      }
      group.models.push(model);
    }
    // Models inside each custom account section are also alphabetized.
    for (const group of customGroups.values()) {
      group.models.sort((a, b) =>
        modelSortKey(a).localeCompare(modelSortKey(b)),
      );
    }
  }

  // Final pass: sort every group (built-in and custom) by display label.
  // Custom sub-sections use `customProviderName` so renaming an account
  // (e.g. "Work" → "Personal") re-orders the dropdown without a code
  // change. Built-in sections use the i18n label (e.g. "Claude
  // Subscription"), so an English-vs-Chinese rename also re-orders.
  return [...groups].sort((a, b) => a.label.localeCompare(b.label));
}

/** Name shown for a model inside its dropdown section: custom models drop
 *  the provider prefix because the section header already names it. */
export function modelListEntryName(model: ModelOption): string {
  if (model.provider === "custom" && model.customModelName) {
    return model.customModelName;
  }
  return model.name;
}
