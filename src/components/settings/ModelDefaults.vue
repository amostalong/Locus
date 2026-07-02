<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../i18n";
import type { ModelOption, ModelDefaults, WorkspaceModelOverride, AgentInfo } from "../../types";
import { isProviderVisible, visibleProviderOrder } from "../../config/providerVisibility";
import { formatModelDisplayName } from "../../utils/modelDisplay";

interface ModelGroup {
  provider: string;
  label: string;
  models: ModelOption[];
}

const props = defineProps<{
  modelDefaults: ModelDefaults;
  allModels: ModelOption[];
  agents: AgentInfo[];
  subagents: AgentInfo[];
  modelSaveMsg: string;
  workingDir: string;
  workspaceOverride: WorkspaceModelOverride | null;
  workspaceOverrideSaveMsg: string;
}>();

const emit = defineEmits<{
  "update:modelDefaults": [defaults: ModelDefaults];
  save: [];
  "update:workspaceOverride": [override: WorkspaceModelOverride];
  saveWorkspaceOverride: [];
  disableWorkspaceOverride: [];
}>();

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    openrouter: "OpenRouter",
    anthropic: t("model.provider.anthropic"),
    claude_code: t("model.provider.claude_code"),
    openai_codex: t("model.provider.openai"),
    custom: t("model.provider.custom"),
  };
  return labels[provider] || provider;
}

function groupedAllModels(): ModelGroup[] {
  const map = new Map<string, ModelOption[]>();
  for (const m of props.allModels) {
    const list = map.get(m.provider) || [];
    list.push(m);
    map.set(m.provider, list);
  }
  const groups: ModelGroup[] = [];
  for (const provider of visibleProviderOrder) {
    const models = map.get(provider);
    if (models && models.length > 0) {
      groups.push({ provider, label: providerLabel(provider), models });
    }
  }
  return groups;
}

function updateMainModel(value: string) {
  emit("update:modelDefaults", { ...props.modelDefaults, mainModel: value });
  emit("save");
}

function updatePlanModel(value: string) {
  emit("update:modelDefaults", { ...props.modelDefaults, planModel: value });
  emit("save");
}

function updateSubagentModel(agentId: string, value: string) {
  const subagentModels = { ...props.modelDefaults.subagentModels, [agentId]: value };
  emit("update:modelDefaults", { ...props.modelDefaults, subagentModels });
  emit("save");
}

const claudeCodeVisible = isProviderVisible("claude_code");

function updateClaudeCodeEnabled(value: boolean) {
  emit("update:modelDefaults", { ...props.modelDefaults, claudeCodeEnabled: value });
  emit("save");
}

const hasWorkspace = computed(() => props.workingDir.trim().length > 0);
const overrideEnabled = computed(() => props.workspaceOverride?.enabled ?? false);

// ── Workspace override helpers ──────────────────────────────────────────

function shortDir(dir: string): string {
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return dir;
  return `.../${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function localOverrideValue(): WorkspaceModelOverride {
  return props.workspaceOverride ?? {
    enabled: false,
    mainModel: "",
    planModel: "",
    subagentModels: {},
  };
}

function onToggleOverride() {
  const current = localOverrideValue();
  if (current.enabled) {
    emit("disableWorkspaceOverride");
  } else {
    const populated: WorkspaceModelOverride = {
      enabled: true,
      mainModel: props.modelDefaults.mainModel,
      planModel: props.modelDefaults.planModel,
      subagentModels: { ...props.modelDefaults.subagentModels },
    };
    emit("update:workspaceOverride", populated);
    emit("saveWorkspaceOverride");
  }
}

function updateOverrideMainModel(value: string) {
  const ov = localOverrideValue();
  ov.mainModel = value;
  emit("update:workspaceOverride", { ...ov });
  emit("saveWorkspaceOverride");
}

function updateOverridePlanModel(value: string) {
  const ov = localOverrideValue();
  ov.planModel = value;
  emit("update:workspaceOverride", { ...ov });
  emit("saveWorkspaceOverride");
}

function updateOverrideSubagentModel(agentId: string, value: string) {
  const ov = localOverrideValue();
  ov.subagentModels = { ...ov.subagentModels, [agentId]: value };
  emit("update:workspaceOverride", { ...ov });
  emit("saveWorkspaceOverride");
}
</script>

<template>
  <div class="settings-section">
    <div class="section-label">{{ t("settings.models.title") }}</div>
    <p class="section-desc">{{ t("settings.models.desc") }}</p>

    <div class="model-default-card">
      <div class="model-default-header">
        <span class="model-default-label">{{ t("settings.models.main") }}</span>
        <span class="model-default-hint">{{ t("settings.models.mainHint") }}</span>
      </div>
      <select :value="modelDefaults.mainModel" class="model-select" @change="updateMainModel(($event.target as HTMLSelectElement).value)">
        <option value="">{{ t("settings.models.mainDefault") }}</option>
        <optgroup v-for="group in groupedAllModels()" :key="group.provider" :label="group.label">
          <option v-for="m in group.models" :key="m.id" :value="m.id">{{ formatModelDisplayName(m.name) }}</option>
        </optgroup>
      </select>
    </div>

    <div class="model-default-card">
      <div class="model-default-header">
        <span class="model-default-label">{{ t("settings.models.plan") }}</span>
        <span class="model-default-hint">{{ t("settings.models.planHint") }}</span>
      </div>
      <select :value="modelDefaults.planModel" class="model-select" @change="updatePlanModel(($event.target as HTMLSelectElement).value)">
        <option value="">{{ t("settings.models.planDefault") }}</option>
        <optgroup v-for="group in groupedAllModels()" :key="group.provider" :label="group.label">
          <option v-for="m in group.models" :key="m.id" :value="m.id">{{ formatModelDisplayName(m.name) }}</option>
        </optgroup>
      </select>
    </div>

    <div class="model-default-card compact" v-if="claudeCodeVisible">
      <div class="model-default-row">
        <div class="model-default-agent">
          <span class="model-default-label">{{ t("settings.models.claudeCodeEnable") }}</span>
          <span class="model-default-hint">{{ t("settings.models.claudeCodeEnableHint") }}</span>
        </div>
        <input
          type="checkbox"
          :checked="modelDefaults.claudeCodeEnabled === true"
          @change="updateClaudeCodeEnabled(($event.target as HTMLInputElement).checked)"
        />
      </div>
    </div>

    <!-- ── Workspace model override ──────────────────────────────────── -->
    <div v-if="hasWorkspace" class="ws-override-section">
      <div class="ws-override-header">
        <div class="ws-override-title-row">
          <span class="ws-override-label">{{ t("settings.models.workspaceOverride.title") }}</span>
          <span class="ws-override-workspace">{{ shortDir(workingDir) }}</span>
        </div>
        <label class="ws-override-toggle">
          <input
            type="checkbox"
            :checked="overrideEnabled"
            @change="onToggleOverride"
          />
          <span class="toggle-slider"></span>
          <span class="toggle-label">{{ t("settings.models.workspaceOverride.enable") }}</span>
        </label>
      </div>

      <div class="model-default-card" :class="{ disabled: !overrideEnabled }">
        <div class="model-default-header">
          <span class="model-default-label">{{ t("settings.models.main") }}</span>
          <span class="model-default-hint">{{ t("settings.models.mainHint") }}</span>
        </div>
        <select
          :value="overrideEnabled ? (workspaceOverride?.mainModel ?? '') : ''"
          class="model-select"
          :disabled="!overrideEnabled"
          @change="overrideEnabled && updateOverrideMainModel(($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ t("settings.models.mainDefault") }}</option>
          <optgroup v-for="group in groupedAllModels()" :key="group.provider" :label="group.label">
            <option v-for="m in group.models" :key="m.id" :value="m.id">{{ m.name }}</option>
          </optgroup>
        </select>
      </div>

      <div class="model-default-card" :class="{ disabled: !overrideEnabled }">
        <div class="model-default-header">
          <span class="model-default-label">{{ t("settings.models.plan") }}</span>
          <span class="model-default-hint">{{ t("settings.models.planHint") }}</span>
        </div>
        <select
          :value="overrideEnabled ? (workspaceOverride?.planModel ?? '') : ''"
          class="model-select"
          :disabled="!overrideEnabled"
          @change="overrideEnabled && updateOverridePlanModel(($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ t("settings.models.planDefault") }}</option>
          <optgroup v-for="group in groupedAllModels()" :key="group.provider" :label="group.label">
            <option v-for="m in group.models" :key="m.id" :value="m.id">{{ m.name }}</option>
          </optgroup>
        </select>
      </div>

      <div v-for="agent in subagents" :key="agent.id" class="model-default-card compact" :class="{ disabled: !overrideEnabled }">
        <div class="model-default-row">
          <div class="model-default-agent">
            <span class="model-default-label">{{ agent.name }}</span>
            <span class="model-default-hint">{{ agent.description }}</span>
          </div>
          <select
            :value="overrideEnabled ? (workspaceOverride?.subagentModels[agent.id] ?? '') : ''"
            class="model-select inline"
            :disabled="!overrideEnabled"
            @change="overrideEnabled && updateOverrideSubagentModel(agent.id, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t("settings.models.subagentDefault") }}</option>
            <optgroup v-for="group in groupedAllModels()" :key="group.provider" :label="group.label">
              <option v-for="m in group.models" :key="m.id" :value="m.id">{{ m.name }}</option>
            </optgroup>
          </select>
        </div>
      </div>

      <div v-if="workspaceOverrideSaveMsg" class="ws-override-save-msg">{{ workspaceOverrideSaveMsg }}</div>
    </div>

    <div class="section-label" style="margin-top: 8px;">{{ t("settings.models.subagent") }}</div>
    <p class="section-desc">{{ t("settings.models.subagentDesc") }}</p>

    <div
      v-for="agent in subagents"
      :key="agent.id"
      class="model-default-card compact"
    >
      <div class="model-default-row">
        <div class="model-default-agent">
          <span class="model-default-label">{{ agent.name }}</span>
          <span class="model-default-hint">{{ agent.description }}</span>
        </div>
        <select
          :value="modelDefaults.subagentModels[agent.id] || ''"
          class="model-select inline"
          @change="updateSubagentModel(agent.id, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ t("settings.models.subagentDefault") }}</option>
          <optgroup v-for="group in groupedAllModels()" :key="group.provider" :label="group.label">
            <option v-for="m in group.models" :key="m.id" :value="m.id">{{ formatModelDisplayName(m.name) }}</option>
          </optgroup>
        </select>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ws-override-section {
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
}
.ws-override-header {
  margin-bottom: 8px;
}
.ws-override-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.ws-override-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-color);
}
.ws-override-workspace {
  font-size: 11px;
  color: var(--text-secondary);
}
.ws-override-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.ws-override-toggle input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.toggle-slider {
  display: inline-block;
  width: 32px;
  height: 18px;
  background: #ccc;
  border-radius: 9px;
  position: relative;
  transition: background 0.2s;
}
.toggle-slider::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}
.ws-override-toggle input:checked + .toggle-slider {
  background: #4caf50;
}
.ws-override-toggle input:checked + .toggle-slider::after {
  transform: translateX(14px);
}
.toggle-label {
  font-size: 12px;
  color: var(--text-secondary);
}
.ws-override-save-msg {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.model-default-card.disabled {
  opacity: 0.5;
  pointer-events: none;
}
</style>
