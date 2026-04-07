<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { Send, Paperclip, X, Loader } from "lucide-vue-next";
import { uploadsApi, type UploadedAsset } from "@/api/uploads";

const props = defineProps<{
  sessionType: "private" | "group";
  /** OneBot private sessions: locked userId derived from session metadata */
  lockedUserId?: string;
  /** Editable default sender for web/group sessions */
  defaultUserId?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  send: [payload: { userId: string; text: string; imageIds: string[] }];
  userIdChange: [userId: string];
}>();

const text    = ref("");
const userId  = ref(props.lockedUserId ?? props.defaultUserId ?? "");

// Sync if parent provides a new default later.
watch(() => props.lockedUserId,   (v) => { if (v != null) userId.value = v; });
watch(() => props.defaultUserId,  (v) => { if (v != null && !props.lockedUserId) userId.value = v; });
watch(userId, (value) => {
  emit("userIdChange", value.trim());
}, { immediate: true });
const textareaRef  = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const attachments  = ref<(UploadedAsset & { preview?: string })[]>([]);
const uploading    = ref(false);

// Auto-resize textarea
watch(text, () => nextTick(resize));
function resize() {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

function send() {
  const trimmed = text.value.trim();
  if ((!trimmed && attachments.value.length === 0) || props.disabled || uploading.value) return;
  emit("send", {
    userId: userId.value.trim() || "10001",
    text: trimmed,
    imageIds: attachments.value.filter((a) => a.kind === "image").map((a) => a.assetId)
  });
  text.value = "";
  attachments.value = [];
  nextTick(resize);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function openFilePicker() {
  fileInputRef.value?.click();
}

async function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (!files.length) return;
  input.value = "";

  // Build local previews immediately
  const previews = files.map((f) => ({
    file: f,
    preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined
  }));

  uploading.value = true;
  try {
    const res = await uploadsApi.uploadFiles(files);
    const uploaded = res.uploads.map((u, i) => ({
      ...u,
      preview: previews[i]?.preview
    }));
    attachments.value = [...attachments.value, ...uploaded];
  } catch (err) {
    console.error("Upload failed:", err);
  } finally {
    uploading.value = false;
  }
}

function removeAttachment(assetId: string) {
  const idx = attachments.value.findIndex((a) => a.assetId === assetId);
  if (idx !== -1) {
    const removed = attachments.value[idx];
    if (removed?.preview) URL.revokeObjectURL(removed.preview);
    attachments.value.splice(idx, 1);
  }
}
</script>

<template>
  <div class="border-t border-border-default bg-surface-sidebar px-3 pt-2 pb-safe-offset-2">
    <!-- User ID row -->
    <div class="mb-1.5 flex items-center gap-2">
      <label class="shrink-0 whitespace-nowrap text-small text-text-muted">发送方 ID</label>
      <!-- Private: locked, read-only badge -->
      <span v-if="lockedUserId" class="rounded border border-border-default bg-surface-muted px-1.75 py-px font-mono text-small text-text-muted select-text">{{ lockedUserId }}</span>
      <!-- Group: editable input -->
      <input
        v-else
        v-model="userId"
        class="input-base max-w-35 px-1.5 py-0.5 font-mono text-small"
        placeholder="userId"
        spellcheck="false"
      />
    </div>

    <!-- Attachment preview strip -->
    <div v-if="attachments.length > 0 || uploading" class="mb-1.5 flex flex-wrap items-center gap-1.5">
      <div v-if="uploading" class="flex items-center gap-1 text-small text-text-muted">
        <Loader :size="14" class="spin" :stroke-width="2" />
        <span>上传中…</span>
      </div>
      <div v-for="att in attachments" :key="att.assetId" class="relative flex max-w-20 items-center overflow-hidden rounded border border-border-default bg-surface-input">
        <img v-if="att.preview" :src="att.preview" class="block h-14 w-14 object-cover" :alt="att.filename" />
        <span v-else class="max-w-20 overflow-hidden text-ellipsis whitespace-nowrap px-1.5 py-1 font-mono text-small text-text-muted">{{ att.filename }}</span>
        <button class="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full border-0 bg-black/65 p-0 text-white hover:bg-danger" @click="removeAttachment(att.assetId)">
          <X :size="10" :stroke-width="2.5" />
        </button>
      </div>
    </div>

    <!-- Input row -->
    <div class="flex items-end gap-1.5">
      <!-- Hidden file input -->
      <input
        ref="fileInputRef"
        type="file"
        accept="image/*,audio/*,video/*,.pdf,.txt,.json,.yaml,.yml,.md"
        multiple
        style="display:none"
        @change="onFilesSelected"
      />

      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-default bg-transparent text-text-muted transition-colors hover:border-text-muted hover:text-text-primary disabled:cursor-default disabled:opacity-40"
        :disabled="disabled || uploading"
        title="附件 / 图片"
        @click="openFilePicker"
      >
        <Paperclip :size="15" :stroke-width="1.75" />
      </button>

      <textarea
        ref="textareaRef"
        v-model="text"
        class="min-h-7 max-h-40 min-w-0 flex-1 resize-none overflow-y-auto rounded border border-border-input bg-surface-input px-2.5 py-1.25 font-ui text-ui leading-6 text-text-primary outline-none placeholder:text-text-subtle focus:border-border-focus disabled:opacity-50"
        placeholder="发送消息… (Enter 发送，Shift+Enter 换行)"
        rows="1"
        :disabled="disabled"
        @keydown="onKeydown"
      />

      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded border-0 bg-accent text-white transition-colors hover:bg-accent-hover disabled:cursor-default disabled:opacity-40"
        :disabled="disabled || uploading || (!text.trim() && attachments.length === 0)"
        title="发送 (Enter)"
        @click="send"
      >
        <Send :size="16" :stroke-width="2" />
      </button>
    </div>
  </div>
</template>
