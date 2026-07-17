
<script setup lang="ts">
import type { PendingQuestion } from "../../types";
import { computed, nextTick, ref } from "vue";
import BaseButton from "../ui/BaseButton.vue";

const props = defineProps<{
  question: PendingQuestion;
}>();

const emit = defineEmits<{
  answer: [answer: string];
}>();

const customAnswer = ref("");
const customInput = ref<HTMLInputElement | null>(null);

const lastOption = computed(() => {
  const opts = props.question.options;
  return opts.length > 0 ? opts[opts.length - 1] : null;
});

function applySuggestion() {
  const text = lastOption.value?.description ?? "";
  customAnswer.value = text;
  nextTick(() => {
    customInput.value?.focus();
  });
}
</script>

<template>
  <div class="ask-user-card">
    <div class="ask-question">{{ question.question }}</div>
    <div class="ask-options">
      <BaseButton
        v-for="(opt, idx) in question.options.slice(0, -1)"
        :key="idx"
        class="ask-option-btn"
        block
        size="md"
        @click="emit('answer', opt.label)"
      >
        <span class="ask-option-label">{{ opt.label }}</span>
        <span class="ask-option-desc">{{ opt.description }}</span>
      </BaseButton>
      <div v-if="lastOption" class="ask-custom">
        <span class="ask-custom-label">{{ lastOption.label }}</span>
        <button
          type="button"
          class="ask-suggestion-chip"
          @click="applySuggestion"
        >
          <span class="ask-suggestion-icon">&#128161;</span>
          <span class="ask-suggestion-text">{{ lastOption.description }}</span>
        </button>
        <div class="ask-custom-input-row">
          <input
            ref="customInput"
            v-model="customAnswer"
            class="ask-custom-input"
            :placeholder="lastOption.description"
            @keydown.enter="customAnswer.trim() && emit('answer', customAnswer.trim())"
          />
          <BaseButton
            class="ask-custom-send"
            variant="primary"
            size="md"
            :disabled="!customAnswer.trim()"
            @click="emit('answer', customAnswer.trim())"
          >&#8593;</BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ask-option-btn {
  min-width: 0;
}

.ask-option-label,
.ask-option-desc {
  display: block;
  width: 100%;
  min-width: 0;
  white-space: normal;
}

.ask-option-desc {
  overflow-wrap: anywhere;
}

.ask-suggestion-chip {
  align-self: flex-start;
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent-color) 8%, transparent);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}

.ask-suggestion-chip:hover {
  border-color: var(--accent-color);
  background: color-mix(in srgb, var(--accent-color) 16%, transparent);
  color: var(--text-color);
}

.ask-suggestion-icon {
  flex-shrink: 0;
  margin-top: 1px;
  font-size: 12px;
}

.ask-suggestion-text {
  overflow-wrap: anywhere;
}
</style>
