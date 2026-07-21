import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useModelStore } from "../stores/model";
import { useAuthStore } from "../stores/auth";

// The model store transitively imports `stores/project` (via useProjectStore)
// which imports the Monaco editor. Monaco pulls in CSS assets through
// `monaco-vscode-api` that vitest's loader rejects ("Unknown file extension
// .css" on Windows). Stubbing the editor module lets the test run without
// pulling the entire Monaco graph into the suite.
vi.mock("../stores/editor", () => ({}));

const modelServiceMocks = vi.hoisted(() => ({
  getModelDefaults: vi.fn(),
  getLastModel: vi.fn(),
  getLastEffort: vi.fn(),
  getCodexFastMode: vi.fn(),
  getCustomProviders: vi.fn(),
  getCodexModelConfig: vi.fn(),
  getCodexAvailableModels: vi.fn(),
  saveLastModel: vi.fn(),
  saveLastEffort: vi.fn(),
  saveCodexFastMode: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionEffort: vi.fn(),
}));

vi.mock("../services/model", () => modelServiceMocks);

function primeStore() {
  modelServiceMocks.getModelDefaults.mockResolvedValue({
    mainModel: "openrouter/claude-sonnet-5",
    planModel: "",
    subagentModels: {},
  });
  modelServiceMocks.getLastModel.mockResolvedValue("");
  modelServiceMocks.getLastEffort.mockResolvedValue("");
  modelServiceMocks.getCodexFastMode.mockResolvedValue(false);
  modelServiceMocks.getCustomProviders.mockResolvedValue([]);
  modelServiceMocks.getCodexModelConfig.mockResolvedValue({ transport: "websocket" });
  modelServiceMocks.getCodexAvailableModels.mockResolvedValue([]);
  modelServiceMocks.saveLastModel.mockResolvedValue(undefined);
  modelServiceMocks.saveLastEffort.mockResolvedValue(undefined);
  modelServiceMocks.saveCodexFastMode.mockResolvedValue(undefined);
  modelServiceMocks.setSessionModel.mockResolvedValue(undefined);
  modelServiceMocks.setSessionEffort.mockResolvedValue(undefined);
}

describe("useModelStore per-session model scope", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    primeStore();
  });

  it("falls back to the global selection when no session override is set", async () => {
    // No active session at all — `effectiveModelId` must follow global.
    const authStore = useAuthStore();
    authStore.hasApiKey = true;
    const modelStore = useModelStore();

    // Drive a global selection through the public path.
    modelStore.selectModel("openrouter/claude-opus-4.8");
    expect(modelStore.selectedModelId).toBe("openrouter/claude-opus-4.8");
    expect(modelStore.effectiveModelId).toBe("openrouter/claude-opus-4.8");
    expect(modelStore.isSessionModelPinned).toBe(false);
  });

  it("applies a per-session override and exposes it via effectiveModelId", () => {
    const modelStore = useModelStore();

    modelStore.selectModel("openrouter/claude-opus-4.8");
    modelStore.setActiveSessionId("sess-A");
    modelStore.applySessionModel("sess-A", "openrouter/claude-sonnet-5");

    // The override wins over the global selection.
    expect(modelStore.effectiveModelId).toBe("openrouter/claude-sonnet-5");
    // The global selection itself is untouched.
    expect(modelStore.selectedModelId).toBe("openrouter/claude-opus-4.8");
    expect(modelStore.isSessionModelPinned).toBe(true);
  });

  it("switching the active session id swaps effectiveModelId", () => {
    const modelStore = useModelStore();

    // Two sessions pinned to two different models.
    modelStore.setActiveSessionId("sess-A");
    modelStore.applySessionModel("sess-A", "openrouter/claude-sonnet-5");

    modelStore.setActiveSessionId("sess-B");
    modelStore.applySessionModel("sess-B", "openrouter/claude-opus-4.8");

    modelStore.setActiveSessionId("sess-A");
    expect(modelStore.effectiveModelId).toBe("openrouter/claude-sonnet-5");
    expect(modelStore.isSessionModelPinned).toBe(true);

    modelStore.setActiveSessionId("sess-B");
    expect(modelStore.effectiveModelId).toBe("openrouter/claude-opus-4.8");

    // A session that has no override follows the global selection.
    modelStore.setActiveSessionId("sess-C");
    expect(modelStore.effectiveModelId).toBe(modelStore.selectedModelId);
    expect(modelStore.isSessionModelPinned).toBe(false);
  });

  it("hydrateSessionOverrides populates the override map in one call", () => {
    const modelStore = useModelStore();
    modelStore.selectModel("openrouter/claude-opus-4.8");
    modelStore.setActiveSessionId("sess-A");

    modelStore.hydrateSessionOverrides([
      { sessionId: "sess-A", modelId: "openrouter/claude-sonnet-5" },
      { sessionId: "sess-B", modelId: "openrouter/claude-opus-4.8" },
      // null and whitespace are dropped (session follows global).
      { sessionId: "sess-C", modelId: null },
      { sessionId: "sess-D", modelId: "   " },
    ]);

    expect(modelStore.effectiveModelId).toBe("openrouter/claude-sonnet-5");
    modelStore.setActiveSessionId("sess-B");
    expect(modelStore.effectiveModelId).toBe("openrouter/claude-opus-4.8");
    modelStore.setActiveSessionId("sess-C");
    expect(modelStore.effectiveModelId).toBe("openrouter/claude-opus-4.8");
    expect(modelStore.isSessionModelPinned).toBe(false);
  });

  it("applySessionModel with null releases the override and falls back to global", () => {
    const modelStore = useModelStore();
    modelStore.selectModel("openrouter/claude-opus-4.8");
    modelStore.setActiveSessionId("sess-A");
    modelStore.applySessionModel("sess-A", "openrouter/claude-sonnet-5");
    expect(modelStore.effectiveModelId).toBe("openrouter/claude-sonnet-5");

    modelStore.applySessionModel("sess-A", null);
    expect(modelStore.effectiveModelId).toBe("openrouter/claude-opus-4.8");
    expect(modelStore.isSessionModelPinned).toBe(false);
  });

  it("selectSessionModel pins the active session and persists, without touching lastModelId", async () => {
    const modelStore = useModelStore();
    // Set a global selection so the per-session test can verify the
    // override is *not* propagated as the global last-known choice.
    modelStore.selectModel("openrouter/claude-opus-4.8");
    modelStore.setActiveSessionId("sess-A");
    // Reset the call log — `selectModel` above legitimately wrote
    // `saveLastModel`; the assertion below is about `selectSessionModel`.
    modelServiceMocks.saveLastModel.mockClear();
    modelServiceMocks.setSessionModel.mockClear();

    await modelStore.selectSessionModel("openrouter/claude-sonnet-5");

    expect(modelStore.effectiveModelId).toBe("openrouter/claude-sonnet-5");
    expect(modelStore.selectedModelId).toBe("openrouter/claude-opus-4.8");
    expect(modelStore.isSessionModelPinned).toBe(true);
    expect(modelServiceMocks.setSessionModel).toHaveBeenCalledWith(
      "sess-A",
      "openrouter/claude-sonnet-5",
    );
    // Per-session selection must not leak into the global lastModelId;
    // otherwise the user's other sessions would follow the new model.
    expect(modelServiceMocks.saveLastModel).not.toHaveBeenCalled();
  });

  it("selectSessionModel trims whitespace before persisting", async () => {
    const modelStore = useModelStore();
    modelStore.setActiveSessionId("sess-A");

    await modelStore.selectSessionModel("  openrouter/claude-sonnet-5  ");

    expect(modelStore.effectiveModelId).toBe("openrouter/claude-sonnet-5");
    expect(modelServiceMocks.setSessionModel).toHaveBeenCalledWith(
      "sess-A",
      "openrouter/claude-sonnet-5",
    );
  });

  it("selectSessionModel without an active session falls back to selectModel", async () => {
    const modelStore = useModelStore();
    // No active session — must NOT call setSessionModel.
    await modelStore.selectSessionModel("openrouter/claude-sonnet-5");

    expect(modelStore.selectedModelId).toBe("openrouter/claude-sonnet-5");
    expect(modelServiceMocks.setSessionModel).not.toHaveBeenCalled();
    // But it should still update lastModelId via the global path.
    expect(modelServiceMocks.saveLastModel).toHaveBeenCalledWith(
      "openrouter/claude-sonnet-5",
    );
  });

  it("selectSessionModel persists even if the backend write fails", async () => {
    modelServiceMocks.setSessionModel.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const modelStore = useModelStore();
    modelStore.setActiveSessionId("sess-A");

    await modelStore.selectSessionModel("openrouter/claude-sonnet-5");

    // Local override is updated immediately so the UI does not block on the
    // backend. The error is logged but the user keeps the pinned model.
    expect(modelStore.effectiveModelId).toBe("openrouter/claude-sonnet-5");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("availableEfforts tracks effectiveModelId, not the global selectedModelId", () => {
    // Enable the openrouter provider so the builtin catalog (with
    // supportedEfforts metadata) is part of `availableModels`. Without
    // this, `availableEfforts` falls back to the generic `claude` set
    // and the test cannot tell the two models apart.
    const authStore = useAuthStore();
    authStore.hasApiKey = true;
    const modelStore = useModelStore();

    // Default: opus 4.8 — built-in catalog advertises the full
    // `["none", "low", "medium", "high", "xhigh", "max"]` set. The dropdown
    // menu expects high-to-low ordering so the user reads the most
    // expensive reasoning level first.
    expect(modelStore.availableEfforts).toEqual([
      "max", "xhigh", "high", "medium", "low", "none",
    ]);

    // Pin the active session to opus 4.6, which advertises
    // `["none", "low", "medium", "high", "max"]` (no `xhigh`). The effort
    // selector must reflect the *pinned* model, not the global opus 4.8.
    modelStore.setActiveSessionId("sess-A");
    modelStore.applySessionModel("sess-A", "claude-opus-4.6");
    expect(modelStore.availableEfforts).toEqual([
      "max", "high", "medium", "low", "none",
    ]);
    expect(modelStore.effortSupported).toBe(true);
  });

  it("switching to a pinned session clamps effort to the nearest supported level instead of resetting to 'low'", async () => {
    const authStore = useAuthStore();
    authStore.hasApiKey = true;
    const modelStore = useModelStore();

    // User starts on opus with xhigh. xhigh is the most expensive
    // supported effort and must round-trip to the user even after a
    // session switch — they did not ask for a reset.
    modelStore.selectModel("openrouter/claude-opus-4.8");
    modelStore.selectEffort("xhigh");
    expect(modelStore.effort).toBe("xhigh");

    // Pin a session to a model that does NOT support xhigh.
    modelStore.setActiveSessionId("sess-A");
    modelStore.applySessionModel("sess-A", "claude-opus-4.6");
    // Let the `watch(availableEfforts, ...)` callback settle so the clamp
    // runs synchronously with the new pinned model in effect.
    await nextTick();

    // The effort selector must drop one step to "high" (the nearest level
    // that the new model supports) rather than snapping back to "low".
    expect(modelStore.effort).toBe("high");
    expect(modelStore.availableEfforts).toContain("high");
    expect(modelStore.availableEfforts).not.toContain("xhigh");
  });

  it("effectiveEffort follows the active session's pinned override", () => {
    const modelStore = useModelStore();
    // No active session — fall back to the global effort.
    modelStore.selectEffort("high");
    expect(modelStore.effectiveEffort).toBe("high");

    // Pin a session to "max" — it must win over the global effort
    // without touching `effort` itself.
    modelStore.setActiveSessionId("sess-A");
    modelStore.applySessionEffort("sess-A", "max");
    expect(modelStore.effectiveEffort).toBe("max");
    expect(modelStore.effort).toBe("high");
    expect(modelStore.isSessionEffortPinned).toBe(true);
  });

  it("switching the active session id swaps effectiveEffort independently", () => {
    const modelStore = useModelStore();
    modelStore.selectEffort("medium");

    modelStore.setActiveSessionId("sess-A");
    modelStore.applySessionEffort("sess-A", "low");

    modelStore.setActiveSessionId("sess-B");
    modelStore.applySessionEffort("sess-B", "high");

    modelStore.setActiveSessionId("sess-A");
    expect(modelStore.effectiveEffort).toBe("low");
    expect(modelStore.isSessionEffortPinned).toBe(true);

    modelStore.setActiveSessionId("sess-B");
    expect(modelStore.effectiveEffort).toBe("high");

    // A session with no effort override follows the global effort.
    modelStore.setActiveSessionId("sess-C");
    expect(modelStore.effectiveEffort).toBe("medium");
    expect(modelStore.isSessionEffortPinned).toBe(false);
  });

  it("hydrateSessionEfforts populates the override map and drops invalid levels", () => {
    const modelStore = useModelStore();
    modelStore.setActiveSessionId("sess-A");

    modelStore.hydrateSessionEfforts([
      { sessionId: "sess-A", effort: "low" },
      { sessionId: "sess-B", effort: "high" },
      // null and unknown / non-EffortLevel values are dropped — the
      // session follows the global effort instead.
      { sessionId: "sess-C", effort: null },
      { sessionId: "sess-D", effort: "ultra" },
    ]);

    expect(modelStore.effectiveEffort).toBe("low");
    modelStore.setActiveSessionId("sess-B");
    expect(modelStore.effectiveEffort).toBe("high");
    modelStore.setActiveSessionId("sess-C");
    expect(modelStore.isSessionEffortPinned).toBe(false);
    modelStore.setActiveSessionId("sess-D");
    expect(modelStore.isSessionEffortPinned).toBe(false);
  });

  it("applySessionEffort(null) releases the override and falls back to global", () => {
    const modelStore = useModelStore();
    modelStore.selectEffort("medium");
    modelStore.setActiveSessionId("sess-A");
    modelStore.applySessionEffort("sess-A", "max");
    expect(modelStore.effectiveEffort).toBe("max");

    modelStore.applySessionEffort("sess-A", null);
    expect(modelStore.effectiveEffort).toBe("medium");
    expect(modelStore.isSessionEffortPinned).toBe(false);
  });

  it("selectSessionEffort pins the active session and persists, without touching the global lastEffort", async () => {
    const modelStore = useModelStore();
    // Set a global effort first so we can prove the per-session path
    // does not leak back into `lastEffort` (different sessions should
    // be free to pick their own reasoning depth).
    modelStore.selectEffort("medium");
    modelStore.setActiveSessionId("sess-A");
    modelServiceMocks.saveLastEffort.mockClear();
    modelServiceMocks.setSessionEffort.mockClear();

    await modelStore.selectSessionEffort("high");

    expect(modelStore.effectiveEffort).toBe("high");
    expect(modelStore.effort).toBe("medium"); // global unchanged
    expect(modelStore.isSessionEffortPinned).toBe(true);
    expect(modelServiceMocks.setSessionEffort).toHaveBeenCalledWith("sess-A", "high");
    // Critical: per-session effort must not pollute the global
    // `lastEffort` persistence, otherwise unrelated sessions would
    // silently start inheriting the new level.
    expect(modelServiceMocks.saveLastEffort).not.toHaveBeenCalled();
  });

  it("selectEffort on a pinned session routes to selectSessionEffort instead of writing lastEffort", async () => {
    const modelStore = useModelStore();
    // Pre-pin the session so the click on the selector must go to the
    // session override, not the global effort ref.
    modelStore.setActiveSessionId("sess-A");
    modelStore.applySessionEffort("sess-A", "low");
    modelServiceMocks.saveLastEffort.mockClear();
    modelServiceMocks.setSessionEffort.mockClear();

    await modelStore.selectEffort("high");

    expect(modelStore.effectiveEffort).toBe("high");
    expect(modelStore.effort).toBe("high"); // default state, never touched
    expect(modelServiceMocks.setSessionEffort).toHaveBeenCalledWith("sess-A", "high");
    expect(modelServiceMocks.saveLastEffort).not.toHaveBeenCalled();
  });

  it("selectEffort on a non-pinned session still updates the global effort ref", () => {
    const modelStore = useModelStore();
    // No active session at all — the global path must run as before.
    expect(modelStore.isSessionEffortPinned).toBe(false);
    modelStore.selectEffort("high");
    // `lastEffort` persistence is gated on `loadLastEffort` setting
    // `effortPersistenceReady = true`; in this test we only care that
    // the ref was updated, not that the backend was called.
    expect(modelStore.effort).toBe("high");
    expect(modelStore.defaultEffort).toBe("high");
    expect(modelStore.hasUserDefaultEffort).toBe(true);
  });

  it("selectSessionEffort persists even if the backend write fails", async () => {
    modelServiceMocks.setSessionEffort.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const modelStore = useModelStore();
    modelStore.setActiveSessionId("sess-A");

    await modelStore.selectSessionEffort("max");

    expect(modelStore.effectiveEffort).toBe("max");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
