import type { ModelDefaults, ModelOption } from "../types";

export function pickPreferredModelId(
  models: ModelOption[],
  defaults: ModelDefaults,
  lastModelId: string,
): string {
  if (models.length === 0) return "";

  const ids = new Set(models.map((model) => model.id));

  // User's manual selection (lastModelId) wins over the settings default —
  // otherwise re-resolving on settings-tab exit would clobber the model the
  // user explicitly picked in the chat view.
  if (lastModelId && ids.has(lastModelId)) {
    return lastModelId;
  }

  if (defaults.mainModel && ids.has(defaults.mainModel)) {
    return defaults.mainModel;
  }

  const defaultModel = models.find((model) => model.isDefault);
  if (defaultModel) {
    return defaultModel.id;
  }

  return models[0]?.id ?? "";
}
