<script setup lang="ts">
import { ref } from "vue";
import { Send } from "lucide-vue-next";

defineProps<{ disabled: boolean }>();
const emit = defineEmits<{
  submit: [input: { instruction: string; constraints: string | null; priority: "normal" | "high" }];
}>();

const instruction = ref("");
const constraints = ref("");
const priority = ref<"normal" | "high">("normal");

function submit() {
  const normalized = instruction.value.trim();
  if (!normalized) return;
  emit("submit", {
    instruction: normalized,
    constraints: constraints.value.trim() || null,
    priority: priority.value
  });
  instruction.value = "";
}
</script>

<template>
  <form class="rounded-lg border border-border-subtle bg-surface-raised p-3" @submit.prevent="submit">
    <label class="mb-2 block text-small font-medium text-text">交给它一件事</label>
    <textarea
      v-model="instruction"
      class="input-base min-h-20 w-full resize-y py-2 text-small"
      placeholder="例如：收集一组铁并送回基地，途中优先保证安全"
      :disabled="disabled"
    />
    <div class="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_8rem_auto]">
      <input
        v-model="constraints"
        class="input-base h-8 text-small"
        placeholder="额外约束（可选）"
        :disabled="disabled"
      >
      <select v-model="priority" class="input-base h-8 text-small" :disabled="disabled">
        <option value="normal">普通优先级</option>
        <option value="high">高优先级</option>
      </select>
      <button class="btn btn-primary h-8 justify-center gap-1.5 px-3" :disabled="disabled || !instruction.trim()">
        <Send :size="13" />
        提交委派
      </button>
    </div>
  </form>
</template>
