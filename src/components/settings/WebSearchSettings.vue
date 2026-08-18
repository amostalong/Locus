<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { t } from "../../i18n";
import BaseSegmented from "../ui/BaseSegmented.vue";
import BaseSwitch from "../ui/BaseSwitch.vue";
import {
  localWebSearchGetConfig,
  localWebSearchSetConfig,
  localWebSearchTestConnection,
} from "../../services/webSearch";
import type { LocalWebSearchStatus, SearchEngine } from "../../types";
import { normalizeAppError } from "../../services/errors";
import { useNotificationStore } from "../../stores/notification";

const notificationStore = useNotificationStore();

const webSearchStatus = ref<LocalWebSearchStatus | null>(null);
const webSearchReady = ref(false);
const webSearchBusy = ref(false);
const webSearchTestBusy = ref(false);
const webSearchTestState = ref<"idle" | "ok" | "fail">("idle");
const webSearchTestMessage = ref("");
// The key is intentionally not pre-populated from the masked `keyHint` — we
// only ever show the masked form, and a clear-then-re-enter flow is the
// expected path for a key rotation.
const webSearchKeyDraft = ref("");
const webSearchSavedKeyPresent = ref(false);
// When the user picks a different engine we still keep the old key in the
// status payload (the server does not clear it on a switch). The draft is
// re-cleared so they must consciously re-paste a key for the new engine
// rather than accidentally hitting "Save" and shipping a Brave key to Exa.
const webSearchEngineDraft = ref<SearchEngine>("brave");

const webSearchEngineOptions = computed(() => [
  { value: "brave" as SearchEngine, label: t("settings.webSearch.engineBrave") },
  { value: "exa" as SearchEngine, label: t("settings.webSearch.engineExa") },
]);

onMounted(() => {
  void refreshWebSearchStatus();
});

async function refreshWebSearchStatus() {
  try {
    const status = await localWebSearchGetConfig();
    webSearchStatus.value = status;
    webSearchSavedKeyPresent.value = status.hasKey;
    webSearchEngineDraft.value = status.engine;
    // Reset the draft only when no in-flight edit exists; keeping the
    // user's current input across refetches is less surprising than
    // clobbering it on every status sync.
    if (webSearchKeyDraft.value.length === 0) {
      webSearchTestState.value = "idle";
      webSearchTestMessage.value = "";
    }
  } catch (e) {
    const err = normalizeAppError(e);
    notificationStore.addNotice("error", err.message, {
      code: err.code,
      operation: "loadWebSearchConfig",
    });
  } finally {
    webSearchReady.value = true;
  }
}

async function saveWebSearchConfig() {
  if (webSearchBusy.value) return;
  webSearchBusy.value = true;
  try {
    const trimmedDraft = webSearchKeyDraft.value.trim();
    // The user may have a key saved but typed nothing in the draft — treat
    // that as "keep the existing key". An explicit clear happens by typing
    // a non-empty value and then deleting it; we send `null` so the backend
    // drops the stored secret instead of leaving the previous one in place.
    const apiKeyToSend = trimmedDraft.length === 0 ? null : trimmedDraft;
    const next = await localWebSearchSetConfig({
      enabled: webSearchStatus.value?.enabled ?? false,
      engine: webSearchEngineDraft.value,
      apiKey: apiKeyToSend,
    });
    webSearchStatus.value = next;
    webSearchSavedKeyPresent.value = next.hasKey;
    webSearchEngineDraft.value = next.engine;
    webSearchKeyDraft.value = "";
    webSearchTestState.value = "idle";
    webSearchTestMessage.value = "";
    notificationStore.addNotice(
      "success",
      t("settings.webSearch.saved"),
      { operation: "saveWebSearchConfig", replaceOperation: true },
    );
  } catch (e) {
    const err = normalizeAppError(e);
    notificationStore.addNotice("error", err.message, {
      code: err.code,
      operation: "saveWebSearchConfig",
      replaceOperation: true,
    });
  } finally {
    webSearchBusy.value = false;
  }
}

async function toggleWebSearchEnabled(next: boolean) {
  if (!webSearchReady.value || webSearchBusy.value) return;
  webSearchBusy.value = true;
  try {
    // When the user flips the toggle we re-send whatever the current draft
    // looks like (or `null` for "keep whatever is already on disk"). The
    // backend merges the two fields, so the resulting active flag mirrors
    // both pieces without a separate path.
    const trimmedDraft = webSearchKeyDraft.value.trim();
    const apiKeyToSend = trimmedDraft.length === 0 ? null : trimmedDraft;
    const next_status = await localWebSearchSetConfig({
      enabled: next,
      engine: webSearchEngineDraft.value,
      apiKey: apiKeyToSend,
    });
    webSearchStatus.value = next_status;
    webSearchSavedKeyPresent.value = next_status.hasKey;
    webSearchEngineDraft.value = next_status.engine;
  } catch (e) {
    const err = normalizeAppError(e);
    notificationStore.addNotice("error", err.message, {
      code: err.code,
      operation: "toggleWebSearchEnabled",
      replaceOperation: true,
    });
  } finally {
    webSearchBusy.value = false;
  }
}

function selectWebSearchEngine(engine: string) {
  if (webSearchBusy.value) return;
  // BaseSegmented emits a raw string; narrow to our known SearchEngine set
  // so we never write an arbitrary value into the typed ref.
  if (engine !== "brave" && engine !== "exa") return;
  const next = engine as SearchEngine;
  if (webSearchEngineDraft.value === next) return;
  webSearchEngineDraft.value = next;
  // The stored key is per-engine in the user's mental model — switching
  // engines invalidates whatever the user typed. They have to re-paste for
  // the new provider.
  webSearchKeyDraft.value = "";
  webSearchTestState.value = "idle";
  webSearchTestMessage.value = "";
}

async function testWebSearchConnection() {
  if (webSearchTestBusy.value) return;
  webSearchTestBusy.value = true;
  webSearchTestState.value = "idle";
  webSearchTestMessage.value = "";
  try {
    await localWebSearchTestConnection();
    webSearchTestState.value = "ok";
    webSearchTestMessage.value = t("settings.webSearch.testOk");
  } catch (e) {
    webSearchTestState.value = "fail";
    const err = normalizeAppError(e);
    webSearchTestMessage.value = err.message;
  } finally {
    webSearchTestBusy.value = false;
  }
}

const webSearchKeyHint = computed(() => {
  if (webSearchKeyDraft.value.length > 0) {
    // Once the user types anything, stop showing the previously saved mask
    // — it would otherwise sit there as a stale ghost value.
    return "";
  }
  return webSearchStatus.value?.keyHint ?? "";
});

const webSearchStatusLabel = computed(() => {
  if (!webSearchReady.value) return t("common.loading");
  if (!webSearchStatus.value) return t("settings.webSearch.statusUnknown");
  if (webSearchStatus.value.active) return t("settings.webSearch.statusActive");
  if (!webSearchStatus.value.hasKey) return t("settings.webSearch.statusNoKey");
  if (!webSearchStatus.value.enabled) return t("settings.webSearch.statusOff");
  return t("settings.webSearch.statusUnknown");
});

const webSearchKeyLabel = computed(() => {
  return webSearchEngineDraft.value === "exa"
    ? t("settings.webSearch.keyLabelExa")
    : t("settings.webSearch.keyLabel");
});

const webSearchKeyPlaceholder = computed(() => {
  if (webSearchKeyHint.value) return webSearchKeyHint.value;
  return webSearchEngineDraft.value === "exa"
    ? t("settings.webSearch.keyPlaceholderExa")
    : t("settings.webSearch.keyPlaceholder");
});

const webSearchDesc = computed(() => {
  return webSearchEngineDraft.value === "exa"
    ? t("settings.webSearch.descExa")
    : t("settings.webSearch.desc");
});
</script>

<template>
  <div class="settings-section">
    <div class="section-label">{{ t("settings.webSearch.title") }}</div>
    <p class="section-desc">
      {{ webSearchDesc }}
      <a
        class="web-search-link"
        :href="webSearchEngineDraft === 'exa' ? 'https://dashboard.exa.ai/api-keys' : 'https://brave.com/search/api/'"
        target="_blank"
        rel="noopener noreferrer"
        >{{ t("settings.webSearch.getKey") }}</a
      >
    </p>
    <div class="web-search-block" :aria-busy="!webSearchReady">
      <div class="web-search-row web-search-engine-row">
        <span class="web-search-key-label">{{ t("settings.webSearch.engineLabel") }}</span>
        <BaseSegmented
          class="web-search-engine-segmented"
          :model-value="webSearchEngineDraft"
          :options="webSearchEngineOptions"
          :aria-label="t('settings.webSearch.engineLabel')"
          size="sm"
          :disabled="webSearchBusy"
          @update:model-value="selectWebSearchEngine"
        />
      </div>
      <div class="web-search-row web-search-master-row">
        <div class="web-search-info">
          <span class="web-search-name">{{ t("settings.webSearch.master") }}</span>
          <span class="web-search-status" :class="`web-search-status-${webSearchStatus?.active ? 'active' : 'inactive'}`">
            {{ webSearchStatusLabel }}
          </span>
        </div>
        <div class="web-search-actions">
          <button
            class="action-btn web-search-btn"
            :disabled="webSearchTestBusy || !webSearchStatus?.active"
            :title="webSearchStatus?.active ? t('settings.webSearch.testTitle') : t('settings.webSearch.testNeedsActive')"
            @click="testWebSearchConnection"
          >
            {{ webSearchTestBusy ? t("common.loading") : t("settings.webSearch.test") }}
          </button>
          <BaseSwitch
            v-if="webSearchReady"
            :model-value="webSearchStatus?.enabled ?? false"
            :disabled="webSearchBusy"
            :aria-label="t('settings.webSearch.master')"
            @update:model-value="toggleWebSearchEnabled"
          />
          <span v-else class="debug-toggle-placeholder" aria-hidden="true" />
        </div>
      </div>
      <div class="web-search-row web-search-key-row">
        <label class="web-search-key-label" for="web-search-key-input">
          {{ webSearchKeyLabel }}
        </label>
        <div class="web-search-key-input-wrap">
          <input
            id="web-search-key-input"
            v-model="webSearchKeyDraft"
            class="web-search-key-input"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="webSearchKeyPlaceholder"
            :disabled="webSearchBusy"
          />
          <button
            class="action-btn web-search-btn"
            :disabled="webSearchBusy"
            @click="saveWebSearchConfig"
          >
            {{ t("settings.webSearch.save") }}
          </button>
        </div>
      </div>
      <div v-if="webSearchTestState !== 'idle'" class="web-search-test-result" :class="`web-search-test-${webSearchTestState}`">
        {{ webSearchTestMessage }}
      </div>
      <p class="web-search-hint">
        {{ t("settings.webSearch.keyHint") }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.web-search-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
  padding: 14px 16px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: color-mix(in srgb, var(--panel-bg) 84%, var(--sidebar-bg) 16%);
}
.web-search-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.web-search-master-row {
  justify-content: space-between;
  flex-wrap: wrap;
}
.web-search-engine-row {
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.web-search-engine-segmented {
  flex: 0 1 auto;
}
.web-search-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.web-search-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-color);
}
.web-search-status {
  font-size: 11.5px;
  color: var(--text-secondary);
}
.web-search-status-active {
  color: var(--status-good-fg, #1f7a3a);
}
.web-search-status-inactive {
  color: var(--text-secondary);
}
.web-search-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.web-search-key-row {
  align-items: stretch;
  flex-wrap: wrap;
}
.web-search-key-label {
  flex: 0 0 auto;
  align-self: center;
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 96px;
}
.web-search-key-input-wrap {
  display: flex;
  gap: 8px;
  flex: 1 1 320px;
  min-width: 0;
}
.web-search-key-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--input-bg);
  color: var(--text-color);
  font-family: var(--font-mono-identifier);
  font-size: 12px;
}
.web-search-key-input:disabled {
  opacity: 0.55;
}
.web-search-btn {
  font-size: 11.5px;
}
.web-search-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.web-search-test-result {
  font-size: 11.5px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  word-break: break-word;
}
.web-search-test-ok {
  border-color: var(--status-good-border, #1f7a3a);
  background: var(--status-good-bg, rgba(31, 122, 58, 0.1));
  color: var(--status-good-fg, #1f7a3a);
}
.web-search-test-fail {
  border-color: var(--status-danger-border, #b04a4a);
  background: var(--status-danger-bg, rgba(176, 74, 74, 0.1));
  color: var(--status-danger-fg, #b04a4a);
}
.web-search-hint {
  font-size: 11px;
  color: var(--text-secondary);
  margin: 0;
}
.web-search-link {
  color: var(--text-link, #4a6cff);
  text-decoration: none;
}
.web-search-link:hover {
  text-decoration: underline;
}
</style>
