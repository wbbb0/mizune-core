<script setup lang="ts">
import { SchemaNode, type UiNode } from "@workbench-kit/vue-resource-editor";
import { ref } from "vue";

const props = defineProps<{
  node: UiNode;
  modelValue: unknown;
  updateModelValue: (value: unknown) => void;
}>();

const draftValue = ref<unknown>(structuredClone(props.modelValue));

function updateDraftValue(value: unknown) {
  draftValue.value = value;
  props.updateModelValue(value);
}
</script>

<template>
  <div class="scrollbar-thin max-h-[70vh] overflow-y-auto px-1 py-1">
    <SchemaNode
      :node="props.node"
      :model-value="draftValue"
      :stored-value="{}"
      :effective-value="draftValue"
      :depth="0"
      @update:model-value="updateDraftValue"
    />
  </div>
</template>
