import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { groupModelsForSelector, modelListEntryName } from "../utils/modelGrouping";
import type { ModelOption } from "../types";

const cwd = process.cwd();

function read(relPath: string) {
  return readFileSync(resolve(cwd, relPath), "utf8");
}

const providerOrder = ["anthropic", "openai_codex", "custom"] as const;
const providerLabels: Record<string, string> = {
  anthropic: "Claude Subscription",
  openai_codex: "ChatGPT Subscription",
  custom: "Custom",
};

function model(partial: Partial<ModelOption> & Pick<ModelOption, "id" | "name" | "provider">): ModelOption {
  return { ...partial, id: partial.id, name: partial.name, provider: partial.provider };
}

describe("model selector grouping", () => {
  it("splits custom models into one section per custom provider, like subscription groups", () => {
    const models: ModelOption[] = [
      model({ id: "claude-opus-4.8", name: "Claude Opus 4.8", provider: "anthropic" }),
      model({ id: "openai/gpt-5.5", name: "GPT-5.5", provider: "openai_codex" }),
      model({
        id: "custom/qingyun/main",
        name: "qingyun-5.5",
        provider: "custom",
        customProviderId: "qingyun",
        customProviderName: "qingyun-5.5",
        customModelName: "qingyun-5.5",
      }),
      model({
        id: "custom/deepseek/v4-flash",
        name: "DeepSeek / DeepSeek V4 Flash",
        provider: "custom",
        customProviderId: "deepseek",
        customProviderName: "DeepSeek",
        customModelName: "DeepSeek V4 Flash",
      }),
      model({
        id: "custom/deepseek/v4-pro",
        name: "DeepSeek / DeepSeek V4 Pro",
        provider: "custom",
        customProviderId: "deepseek",
        customProviderName: "DeepSeek",
        customModelName: "DeepSeek V4 Pro",
      }),
    ];

    const groups = groupModelsForSelector(models, providerOrder, providerLabels);

    // Sections are sorted alphabetically by their *display label* so the
    // user reads providers in the order they expect to see them.
    //   "ChatGPT Subscription" (C-h) < "Claude Subscription" (C-l)
    //   < "DeepSeek" (D) < "qingyun-5.5" (q)
    expect(groups.map((g) => g.key)).toEqual([
      "openai_codex",
      "anthropic",
      "custom:deepseek",
      "custom:qingyun",
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "ChatGPT Subscription",
      "Claude Subscription",
      "DeepSeek",
      "qingyun-5.5",
    ]);
    // Every custom group keeps provider "custom" so provider-specific UI
    // (e.g. the codex fast toggle check) stays keyed on real providers.
    expect(groups.filter((g) => g.key.startsWith("custom:")).every((g) => g.provider === "custom")).toBe(true);
    // Models inside a section are sorted alphabetically by their dropdown
    // label (customModelName when present, otherwise `name`). Among the
    // DeepSeek entries "DeepSeek V4 Flash" < "DeepSeek V4 Pro" (F before P
    // in locale-aware ordering), so v4-flash lands first.
    expect(groups[2].models.map((m) => m.id)).toEqual([
      "custom/deepseek/v4-flash",
      "custom/deepseek/v4-pro",
    ]);
  });

  it("sorts models alphabetically within each built-in section", () => {
    const models: ModelOption[] = [
      model({ id: "openrouter/claude-opus-4.8", name: "Claude Opus 4.8", provider: "openrouter" }),
      model({ id: "openrouter/glm-5", name: "GLM 5", provider: "openrouter" }),
      model({ id: "openrouter/claude-fable-5", name: "Claude Fable 5", provider: "openrouter" }),
      model({ id: "openrouter/claude-sonnet-5", name: "Claude Sonnet 5", provider: "openrouter" }),
    ];

    const groups = groupModelsForSelector(models, ["openrouter"], {});
    expect(groups).toHaveLength(1);
    // The source order is Opus 4.8, GLM 5, Fable 5, Sonnet 5. The output
    // must be Fable 5, Opus 4.8, Sonnet 5, GLM 5 — alphabetical by display
    // name. (Note: localeCompare is case-insensitive by default; Opus
    // and Sonnet share the "Claude" prefix but differ on the second word.)
    expect(groups[0].models.map((m) => m.name)).toEqual([
      "Claude Fable 5",
      "Claude Opus 4.8",
      "Claude Sonnet 5",
      "GLM 5",
    ]);
  });

  it("does not mutate the input model array", () => {
    const models: ModelOption[] = [
      model({ id: "anthropic/z", name: "Z", provider: "anthropic" }),
      model({ id: "anthropic/a", name: "A", provider: "anthropic" }),
    ];
    const original = models.map((m) => m.id);
    groupModelsForSelector(models, ["anthropic"], {});
    expect(models.map((m) => m.id)).toEqual(original);
  });

  it("sorts every group by display label, including user-named custom accounts", () => {
    // No `providerLabels` override here — built-in sections fall back to
    // their provider id for sorting, custom accounts still use the
    // user-chosen name. The output is the merged sort:
    //   "anthropic" (a) < "openai_codex" (o-p-e-n-a) < "openrouter" (o-p-e-n-r) < "Z Provider" (Z)
    // Note that uppercase Z lands *before* lowercase letters under
    // localeCompare's default case-sensitive ordering — that is the
    // expected, deterministic result the user is asking for.
    const providerOrder = ["openrouter", "anthropic", "openai_codex", "custom"] as const;
    const models: ModelOption[] = [
      model({ id: "openrouter/a", name: "OR-A", provider: "openrouter" }),
      model({ id: "anthropic/b", name: "ANT-B", provider: "anthropic" }),
      model({ id: "openai/gpt-5.5", name: "GPT-5.5", provider: "openai_codex" }),
      model({
        id: "custom/zz/last",
        name: "Z",
        provider: "custom",
        customProviderId: "zz",
        customProviderName: "Z Provider",
        customModelName: "z",
      }),
    ];

    const groups = groupModelsForSelector(models, providerOrder, {});
    expect(groups.map((g) => g.key)).toEqual([
      "anthropic",
      "openai_codex",
      "openrouter",
      "custom:zz",
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "anthropic",
      "openai_codex",
      "openrouter",
      "Z Provider",
    ]);
  });

  it("renaming a custom provider slides the section to the new alphabetical slot", () => {
    // Same two custom accounts, but the second is renamed from
    // "B Provider" to "Aaa Co". The section must jump to the top of
    // the list — the user should never need to re-order config to
    // change the dropdown.
    const models: ModelOption[] = [
      model({
        id: "custom/zz/one",
        name: "Z",
        provider: "custom",
        customProviderId: "zz",
        customProviderName: "Z Provider",
        customModelName: "z",
      }),
      model({
        id: "custom/aa/one",
        name: "A",
        provider: "custom",
        customProviderId: "aa",
        customProviderName: "Aaa Co",
        customModelName: "a",
      }),
    ];

    const groups = groupModelsForSelector(models, providerOrder, providerLabels);
    expect(groups.map((g) => g.key)).toEqual(["custom:aa", "custom:zz"]);
  });

  it("skips empty providers and orders the remaining sections by label", () => {
    // Only the two custom accounts are populated. Built-in providers
    // are skipped (no models in `byProvider`) and the custom sections
    // land in alphabetical order by their user-chosen name.
    const models: ModelOption[] = [
      model({
        id: "custom/b/one",
        name: "B",
        provider: "custom",
        customProviderId: "b",
        customProviderName: "B Provider",
        customModelName: "one",
      }),
      model({
        id: "custom/a/one",
        name: "A",
        provider: "custom",
        customProviderId: "a",
        customProviderName: "A Provider",
        customModelName: "one",
      }),
    ];

    const groups = groupModelsForSelector(models, providerOrder, providerLabels);
    expect(groups.map((g) => g.key)).toEqual(["custom:a", "custom:b"]);
  });

  it("falls back to the generic custom label when grouping metadata is missing", () => {
    const models: ModelOption[] = [
      model({ id: "custom/legacy", name: "Legacy", provider: "custom" }),
    ];

    const groups = groupModelsForSelector(models, providerOrder, providerLabels);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("custom:");
    expect(groups[0].label).toBe("Custom");
  });

  it("drops the provider prefix inside a custom section but keeps full names elsewhere", () => {
    const custom = model({
      id: "custom/deepseek/v4-flash",
      name: "DeepSeek / DeepSeek V4 Flash",
      provider: "custom",
      customProviderId: "deepseek",
      customProviderName: "DeepSeek",
      customModelName: "DeepSeek V4 Flash",
    });
    const builtin = model({ id: "claude-opus-4.8", name: "Claude Opus 4.8", provider: "anthropic" });
    const legacy = model({ id: "custom/legacy", name: "Legacy", provider: "custom" });

    expect(modelListEntryName(custom)).toBe("DeepSeek V4 Flash");
    expect(modelListEntryName(builtin)).toBe("Claude Opus 4.8");
    expect(modelListEntryName(legacy)).toBe("Legacy");
  });

  it("joins provider and model names with a slash, not a middle dot", () => {
    const source = read("src/stores/model.ts");
    expect(source).toContain("`${provider.name} / ${model.name}`");
    expect(source).not.toContain("·");
  });

  it("both selector dropdowns render per-provider custom sections", () => {
    for (const path of ["src/components/ModelSelector.vue", "src/components/ModelEffortSelector.vue"]) {
      const source = read(path);
      expect(source).toContain("groupModelsForSelector");
      expect(source).toContain('key="group.key"');
      expect(source).toContain("optionDisplayName(model)");
    }
  });

  it("collapsed trigger shows the bare name and only prefixes the provider on duplicates", () => {
    for (const path of ["src/components/ModelSelector.vue", "src/components/ModelEffortSelector.vue"]) {
      const source = read(path);
      // The duplicate check compares the same bare names the dropdown shows...
      expect(source).toMatch(/duplicated = props\.models\.some\(\s*\(m(odel)?\) => m(odel)?\.id !== sel(ected)?\.id && optionDisplayName\(m(odel)?\) === displayName,?\s*\)/);
      // ...and a duplicated custom model is prefixed with its provider name.
      expect(source).toContain("customProviderName} / ${displayName}");
    }
  });
});
