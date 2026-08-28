<script setup lang="ts">
import type { SessionModelRoutingPreferences } from "@/api/types";

const props = defineProps<{
  modelValue: SessionModelRoutingPreferences;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [preferences: SessionModelRoutingPreferences];
}>();

function updateSelfUpgradeEnabled(event: Event): void {
  emit("update:modelValue", {
    selfUpgradeEnabled: (event.target as HTMLInputElement).checked
  });
}
</script>

<template>
  <section class="rounded-lg border border-border-default bg-surface-panel p-4">
    <div class="mb-4">
      <h3 class="text-ui font-medium text-text-primary">模型路由</h3>
      <p class="mt-1 text-small leading-5 text-text-subtle">
        控制本会话是否允许小模型在任务明显超出自身能力时，请求切换到同一 provider 下配置的完整模型。
      </p>
    </div>
    <label class="flex items-start justify-between gap-4 rounded-lg border border-border-default bg-surface-sidebar px-3 py-2.5">
      <span class="min-w-0">
        <span class="block text-small text-text-secondary">允许模型自行升级</span>
        <span class="mt-0.5 block text-small leading-5 text-text-subtle">
          仅在 main_small 与 main_large 的全部候选都属于同一 provider、模型不同且支持工具时可用。切换不会改变本轮工具权限；修改从下一轮生成开始生效。
        </span>
      </span>
      <input
        class="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
        type="checkbox"
        :checked="modelValue.selfUpgradeEnabled"
        :disabled="disabled"
        @change="updateSelfUpgradeEnabled"
      />
    </label>
  </section>
</template>
