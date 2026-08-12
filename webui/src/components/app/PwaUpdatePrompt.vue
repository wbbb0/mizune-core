<script setup lang="ts">
import { computed } from "vue";
import { WorkbenchDialog } from "@workbench-kit/vue";
import { usePwaUpdate } from "@/composables/usePwaUpdate";

const { updateAvailable, updating, updateError, applyUpdate, dismissUpdate } = usePwaUpdate();

const message = computed(() => updateError.value
  ?? "刷新后即可使用最新版本，当前页面不会自动中断。"
);

function handleVisibilityChange(open: boolean) {
  if (!open) {
    dismissUpdate();
  }
}
</script>

<template>
  <WorkbenchDialog
    :accept-keyboard-confirm="!updating"
    :close-on-backdrop="!updating"
    :close-on-escape="!updating"
    :model-value="updateAvailable"
    size="sm"
    title="WebUI 新版本已就绪"
    @cancel="dismissUpdate"
    @confirm="applyUpdate"
    @update:model-value="handleVisibilityChange"
  >
    <p class="whitespace-pre-line text-small leading-5" :class="updateError ? 'text-danger' : 'text-text-secondary'">
      {{ message }}
    </p>

    <template #footer>
      <button class="btn btn-secondary" type="button" :disabled="updating" @click="dismissUpdate">
        稍后
      </button>
      <button class="btn btn-primary" type="button" :disabled="updating" @click="applyUpdate">
        {{ updating ? "正在激活…" : "立即刷新" }}
      </button>
    </template>
  </WorkbenchDialog>
</template>
