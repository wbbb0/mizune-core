<script setup lang="ts">
import { computed, ref } from "vue";
import { RefreshCw, RotateCcw, Save, Wand2 } from "lucide-vue-next";
import { SchemaNode } from "@workbench-kit/vue-resource-editor";
import { useElementWidth } from "@/composables/useElementWidth";
import { useConfigSection } from "@/composables/sections/useConfigSection";
import { WorkbenchAreaHeader, WorkbenchEmptyState } from "@workbench-kit/vue-workbench";

const {
  selectedKey,
  model,
  loading,
  saving,
  standardizing,
  validating,
  draftValue,
  referenceValue,
  storedDraftValue,
  effectiveValue,
  isGlobalConfigSelected,
  canSave,
  canValidate,
  canUseDefaultValue,
  canStandardize,
  reloadFromServer,
  validate,
  save,
  useDefaultValue,
  standardize,
  updateDraft
} = useConfigSection();

const paneRef = ref<HTMLElement | null>(null);
const paneWidth = useElementWidth(paneRef);
const compactPane = computed(() => paneWidth.value > 0 && paneWidth.value < 640);
</script>

<template>
  <div ref="paneRef" class="flex h-full flex-col overflow-hidden">
    <WorkbenchEmptyState v-if="!selectedKey" message="← 选择一个配置项" />

    <WorkbenchEmptyState v-else-if="loading">
      <template #icon>
        <RefreshCw :size="16" class="spin" :stroke-width="2" />
      </template>
      加载中…
    </WorkbenchEmptyState>

    <template v-else-if="model">
      <WorkbenchAreaHeader class="flex-wrap gap-2.5 px-4" :class="compactPane ? 'items-start' : ''" :uppercase="false">
        <span class="shrink-0 rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ model.kind }}</span>
        <template #actions>
        <div class="flex gap-1.5" :class="compactPane ? 'w-full flex-wrap justify-end' : 'ml-auto'">
          <button class="btn btn-secondary" :disabled="loading || saving || validating || standardizing || !model" @click="reloadFromServer">
            <RefreshCw :size="13" :stroke-width="2" />
            重新读取
          </button>
          <button class="btn btn-secondary" :disabled="standardizing || !canValidate" @click="validate">
            <RefreshCw v-if="validating" :size="13" class="spin" :stroke-width="2" />
            验证
          </button>
          <button v-if="isGlobalConfigSelected" class="btn btn-secondary" :disabled="!canUseDefaultValue" @click="useDefaultValue">
            <RotateCcw :size="13" :stroke-width="2" />
            使用默认值
          </button>
          <button v-if="isGlobalConfigSelected" class="btn btn-secondary" :disabled="!canStandardize" @click="standardize">
            <RefreshCw v-if="standardizing" :size="13" class="spin" :stroke-width="2" />
            <Wand2 v-else :size="13" :stroke-width="1.8" />
            {{ standardizing ? "标准化中…" : "标准化" }}
          </button>
          <button class="btn btn-primary" :disabled="standardizing || !canSave" @click="save">
            <Save :size="13" :stroke-width="1.5" />
            {{ saving ? "保存中…" : "保存" }}
          </button>
        </div>
        </template>
      </WorkbenchAreaHeader>

      <div class="scrollbar-thin flex-1 overflow-y-auto px-4 py-3">
        <SchemaNode
          :node="model.uiTree"
          :model-value="draftValue"
          :inherited="referenceValue"
          :default-value="model.schemaDefaultValue"
          :stored-value="storedDraftValue"
          :effective-value="effectiveValue"
          :editor-features="model.editorFeatures"
          :depth="0"
          @update:model-value="updateDraft"
        />
      </div>
    </template>
  </div>
</template>
