<script setup lang="ts">
import { RefreshCw, Save } from "lucide-vue-next";
import SchemaNode from "@/components/editor/SchemaNode.vue";
import { useConfigSection } from "@/composables/sections/useConfigSection";
import type { LayeredEditorModel, SingleEditorModel } from "@/api/editor";

const {
  selectedKey,
  model,
  loading,
  saving,
  validating,
  draftValue,
  isLayered,
  baseValue,
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
    <div v-if="!selectedKey" class="panel-empty flex flex-1 items-center justify-center gap-2">← 选择一个配置项</div>

    <div v-else-if="loading" class="panel-empty flex flex-1 items-center justify-center gap-2">
      <RefreshCw :size="16" class="spin" :stroke-width="2" />
      <span>加载中…</span>
    </div>

    <template v-else-if="model">
      <header class="toolbar-header flex h-10 shrink-0 flex-wrap items-center gap-2.5 border-b px-4 py-1.5">
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ model.kind }}</span>
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
      </header>

      <div class="scrollbar-thin flex-1 overflow-y-auto px-4 py-3">
        <SchemaNode
          :node="model.uiTree"
          :model-value="draftValue"
          :inherited="model.kind === 'layered' ? baseValue : (model as SingleEditorModel).current"
          :base-value="isLayered ? baseValue : undefined"
          :stored-value="storedDraftValue"
          :effective-value="effectiveValue"
          :layer-features="model.kind === 'layered' ? (model as LayeredEditorModel).layerFeatures : undefined"
          :is-layered="isLayered"
          :depth="0"
          @update:model-value="updateDraft"
        />
      </div>
    </template>
  </div>
</template>
