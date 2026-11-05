<script setup lang="ts">
import { computed } from "vue";
import { ExternalLink, Image as ImageIcon, Trash2 } from "lucide-vue-next";
import { fileApi } from "@/api/workspace";

interface ReferenceImageDraftItem {
  id: string;
  fileId: string;
  label: string;
  subject: string | null;
  description: string;
}

const props = defineProps<{
  modelValue: unknown;
  storedValue?: unknown;
  readOnly?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: unknown];
}>();

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const storedById = computed(() => {
  const map = new Map<string, { fileId: string; subject: string | null }>();
  const storedSocial = asRecord(asRecord(props.storedValue).social);
  const rawList = storedSocial.referenceImages;
  if (!Array.isArray(rawList)) return map;
  for (const entry of rawList) {
    const obj = asRecord(entry);
    const id = typeof obj.id === "string" ? obj.id : "";
    if (!id) continue;
    map.set(id, {
      fileId: typeof obj.fileId === "string" ? obj.fileId : "",
      subject: typeof obj.subject === "string" && obj.subject.trim() ? obj.subject.trim() : null
    });
  }
  return map;
});

const items = computed<ReferenceImageDraftItem[]>(() => {
  const social = asRecord(asRecord(props.modelValue).social);
  const rawList = social.referenceImages;
  if (!Array.isArray(rawList)) return [];
  return rawList.map((entry) => {
    const obj = asRecord(entry);
    const id = typeof obj.id === "string" ? obj.id : "";
    const storedSource = id ? storedById.value.get(id) : undefined;
    return {
      id,
      fileId: storedSource ? storedSource.fileId : (typeof obj.fileId === "string" ? obj.fileId : ""),
      label: typeof obj.label === "string" ? obj.label : "",
      subject: storedSource
        ? storedSource.subject
        : (typeof obj.subject === "string" && obj.subject.trim() ? obj.subject.trim() : null),
      description: typeof obj.description === "string" ? obj.description : ""
    };
  });
});

function getPreviewUrl(fileId: string): string {
  const trimmed = fileId.trim();
  return trimmed ? fileApi.getChatFileContentUrlById(trimmed) : "";
}

function emitNextItems(nextItems: ReferenceImageDraftItem[]) {
  const root = { ...asRecord(props.modelValue) };
  const social = { ...asRecord(root.social), referenceImages: nextItems };
  root.social = social;
  emit("update:modelValue", root);
}

function updateItemField(index: number, field: "label" | "description", value: string) {
  if (props.readOnly) return;
  const next = items.value.map((item, idx) => (idx === index ? { ...item, [field]: value } : { ...item }));
  emitNextItems(next);
}

function removeItem(index: number) {
  if (props.readOnly) return;
  const next = items.value.filter((_, idx) => idx !== index);
  emitNextItems(next);
}
</script>

<template>
  <section class="mt-4 rounded-md border border-border-default bg-surface-base p-3">
    <div class="mb-2 flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2">
        <ImageIcon :size="14" class="shrink-0 text-text-muted" :stroke-width="2" />
        <span class="truncate text-small font-medium text-text-primary">角色参考图 (social.referenceImages)</span>
        <span class="shrink-0 rounded-full bg-surface-muted px-1.5 py-0.5 font-mono text-small text-text-subtle">
          {{ items.length }}
        </span>
      </div>
      <span class="text-small text-text-subtle">已存条目的来源字段只读</span>
    </div>

    <div
      v-if="items.length === 0"
      class="rounded border border-dashed border-border-subtle px-3 py-4 text-center text-small text-text-subtle"
    >
      暂无角色参考图（可在聊天配置阶段通过 import_character_reference 导入）
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="(item, index) in items"
        :key="item.id || `${index}`"
        class="rounded border border-border-subtle bg-surface-muted/40 p-3"
      >
        <div class="mb-2 flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <span class="font-mono text-small text-text-subtle">#{{ index + 1 }}</span>
            <span class="truncate text-small font-medium text-text-primary">{{ item.label || item.id || "角色设定图" }}</span>
            <span v-if="item.id" class="truncate rounded bg-surface-muted px-1.5 py-0.5 font-mono text-small text-text-subtle">
              {{ item.id }}
            </span>
          </div>
          <button
            type="button"
            class="btn-ghost text-text-subtle hover:text-danger"
            title="删除此参考图"
            :disabled="readOnly"
            @click="removeItem(index)"
          >
            <Trash2 :size="13" :stroke-width="2" />
          </button>
        </div>

        <div class="flex flex-col gap-3 sm:flex-row">
          <div class="flex shrink-0 flex-col items-start gap-1.5 sm:w-36">
            <a
              v-if="getPreviewUrl(item.fileId)"
              :href="getPreviewUrl(item.fileId)"
              target="_blank"
              rel="noopener noreferrer"
              class="block overflow-hidden rounded border border-border-default bg-surface-base"
              title="点击在新标签页打开受鉴权原图"
            >
              <img
                :src="getPreviewUrl(item.fileId)"
                :alt="item.label || item.fileId"
                loading="lazy"
                class="max-h-36 w-36 object-contain"
              />
            </a>
            <a
              v-if="getPreviewUrl(item.fileId)"
              :href="getPreviewUrl(item.fileId)"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 text-small text-accent hover:underline"
            >
              <ExternalLink :size="12" :stroke-width="2" />
              打开原图
            </a>
          </div>

          <div class="min-w-0 flex-1 space-y-2">
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div class="flex flex-col gap-0.5">
                <span class="text-small text-text-subtle">图片资产 ID (fileId · 只读)</span>
                <span class="truncate rounded border border-border-subtle bg-surface-muted px-2 py-1 font-mono text-mono text-text-secondary" :title="item.fileId">
                  {{ item.fileId || "-" }}
                </span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-small text-text-subtle">画面目标主体 (subject · 只读)</span>
                <span class="truncate rounded border border-border-subtle bg-surface-muted px-2 py-1 font-mono text-mono text-text-secondary" :title="item.subject ?? 'null'">
                  {{ item.subject ?? "null（整图单人角色）" }}
                </span>
              </div>
            </div>

            <div class="flex flex-col gap-1">
              <label class="text-small font-medium text-text-secondary">参考图标签 (label)</label>
              <input
                type="text"
                class="input-base h-7 w-full max-w-96 rounded-md px-2 text-small"
                :value="item.label"
                :disabled="readOnly"
                placeholder="如：日常立绘、正背面三视图"
                @input="updateItemField(index, 'label', ($event.target as HTMLInputElement).value)"
              />
            </div>

            <div class="flex flex-col gap-1">
              <label class="text-small font-medium text-text-secondary">视觉特征描述 (description)</label>
              <textarea
                class="input-base min-h-24 w-full resize-y rounded-md px-2 py-1.5 text-ui leading-[1.4]"
                rows="4"
                :value="item.description"
                :disabled="readOnly"
                placeholder="针对目标角色的完整视觉特征描述"
                @input="updateItemField(index, 'description', ($event.target as HTMLTextAreaElement).value)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
