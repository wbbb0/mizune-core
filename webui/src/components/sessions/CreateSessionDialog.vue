<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import WorkbenchDialog from "@/components/common/WorkbenchDialog.vue";

const props = defineProps<{
  open: boolean;
  busy?: boolean;
  errorMessage?: string;
  modes?: Array<{ id: string; title: string; description: string }>;
}>();

const emit = defineEmits<{
  close: [];
  submit: [payload: { participantLabel?: string; modeId?: string }];
}>();

const participantLabel = ref("");
const modeId = ref("rp_assistant");

const canSubmit = computed(() => !props.busy);

watch(() => props.open, async (open) => {
  if (!open) {
    participantLabel.value = "";
    modeId.value = props.modes?.[0]?.id ?? "rp_assistant";
    return;
  }
}, { immediate: true });

async function submit() {
  emit("submit", {
    ...(participantLabel.value.trim() ? { participantLabel: participantLabel.value.trim() } : {}),
    ...(modeId.value.trim() ? { modeId: modeId.value.trim() } : {})
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
    description="创建一个 owner Web 会话。这个表单只保留展示与模式字段。"
    variant="content"
    width-class="max-w-xl"
    body-class="px-4 py-4"
    @close="close"
  >
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <label class="flex flex-col gap-1.5 text-small text-text-muted">
        显示名称
        <input
          v-model="participantLabel"
          class="input-base text-ui"
          placeholder="例如 Owner"
        />
        <span class="text-small text-text-subtle">可选。用于列表、标题栏和聊天区展示。</span>
      </label>

      <label class="flex flex-col gap-1.5 text-small text-text-muted">
        会话模式
        <select v-model="modeId" class="input-base text-ui">
          <option v-for="mode in modes ?? []" :key="mode.id" :value="mode.id">
            {{ mode.title }}
          </option>
        </select>
        <span class="text-small text-text-subtle">
          {{ (modes ?? []).find((item) => item.id === modeId)?.description ?? "选择新会话的运行模式。" }}
        </span>
      </label>

      <div class="rounded border border-border-default bg-surface-sidebar px-3 py-2 text-small leading-5 text-text-muted">
        当前会创建一个绑定到 `owner` 的 `web:*` 私聊会话，并使用所选 mode。
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
