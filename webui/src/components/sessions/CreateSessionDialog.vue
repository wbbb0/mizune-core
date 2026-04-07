<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import WorkbenchDialog from "@/components/common/WorkbenchDialog.vue";

const props = defineProps<{
  open: boolean;
  busy?: boolean;
  errorMessage?: string;
}>();

const emit = defineEmits<{
  close: [];
  submit: [payload: { participantUserId: string; participantLabel?: string }];
}>();

const participantUserId = ref("");
const participantLabel = ref("");
const userIdInput = ref<HTMLInputElement | null>(null);

const canSubmit = computed(() => participantUserId.value.trim().length > 0 && !props.busy);

watch(() => props.open, async (open) => {
  if (!open) {
    participantUserId.value = "";
    participantLabel.value = "";
    return;
  }
  await nextTick();
  userIdInput.value?.focus();
}, { immediate: true });

async function submit() {
  const normalizedUserId = participantUserId.value.trim();
  if (!normalizedUserId) {
    await nextTick();
    userIdInput.value?.focus();
    return;
  }
  emit("submit", {
    participantUserId: normalizedUserId,
    ...(participantLabel.value.trim() ? { participantLabel: participantLabel.value.trim() } : {})
  });
}

function close() {
  if (props.busy) {
    return;
  }
  emit("close");
}
</script>

<template>
  <WorkbenchDialog
    :open="open"
    title="新建会话"
    description="创建一个 Web 会话。这个表单是通用会话入口，后续可以继续扩展更多字段。"
    width-class="max-w-xl"
    @close="close"
  >
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label class="flex flex-col gap-1.5 text-small text-text-muted">
          用户 ID
          <input
            ref="userIdInput"
            v-model="participantUserId"
            class="input-base font-mono text-ui"
            placeholder="例如 alice / user-001"
            spellcheck="false"
          />
          <span class="text-small text-text-subtle">会作为会话参与者标识保存，用于 transcript、memory 和后续扩展。</span>
        </label>

        <label class="flex flex-col gap-1.5 text-small text-text-muted">
          显示名称
          <input
            v-model="participantLabel"
            class="input-base text-ui"
            placeholder="例如 Alice"
          />
          <span class="text-small text-text-subtle">可选。用于列表、标题栏和聊天区展示。</span>
        </label>
      </div>

      <div class="rounded border border-border-default bg-surface-sidebar px-3 py-2 text-small leading-5 text-text-muted">
        当前默认会创建一个 `web:*` 私聊会话。
      </div>

      <div
        v-if="errorMessage"
        class="rounded border border-[color:color-mix(in_srgb,var(--danger)_55%,transparent)] bg-surface-danger px-3 py-2 text-small text-danger"
      >
        {{ errorMessage }}
      </div>
    </form>

    <template #footer>
      <button class="btn btn-secondary" :disabled="busy" @click="close">
        取消
      </button>
      <button class="btn btn-primary" :disabled="!canSubmit" @click="submit">
        {{ busy ? "创建中…" : "创建会话" }}
      </button>
    </template>
  </WorkbenchDialog>
</template>
