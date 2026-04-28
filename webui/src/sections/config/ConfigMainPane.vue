<script setup lang="ts">
import { RefreshCw, Save } from "lucide-vue-next";
import SchemaNode from "@/components/editor/SchemaNode.vue";
import { useConfigSection } from "@/composables/sections/useConfigSection";
import { WorkbenchAreaHeader, WorkbenchEmptyState } from "@/components/workbench/primitives";

const {
  selectedKey,
  model,
  loading,
  saving,
  validating,
  draftValue,
  referenceValue,
  storedDraftValue,
  effectiveValue,
  canSave,
  canValidate,
  reloadFromServer,
  validate,
  save,
  updateDraft
} = useConfigSection();
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <WorkbenchEmptyState v-if="!selectedKey" message="← 选择一个配置项" />

    <WorkbenchEmptyState v-else-if="loading">
      <template #icon>
        <RefreshCw :size="16" class="spin" :stroke-width="2" />
      </template>
      加载中…
    </WorkbenchEmptyState>

    <template v-else-if="model">
      <WorkbenchAreaHeader class="flex-wrap gap-2.5 px-4" :uppercase="false">
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ model.kind }}</span>
        <template #actions>
        <div class="ml-auto flex gap-1.5">
          <button class="btn btn-secondary" :disabled="loading || saving || validating || !model" @click="reloadFromServer">
            <RefreshCw :size="13" :stroke-width="2" />
            重新读取
          </button>
          <button class="btn btn-secondary" :disabled="!canValidate" @click="validate">
            <RefreshCw v-if="validating" :size="13" class="spin" :stroke-width="2" />
            验证
          </button>
          <button class="btn btn-primary" :disabled="!canSave" @click="save">
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
