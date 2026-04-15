<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { RefreshCw, Save, CheckCircle, AlertCircle } from "lucide-vue-next";
import AppLayout from "@/components/layout/AppLayout.vue";
import SchemaNode from "@/components/editor/SchemaNode.vue";
import { editorApi, type EditorResourceSummary, type EditorModel, type LayeredEditorModel, type SingleEditorModel } from "@/api/editor";
import { useLayeredEditorState } from "@/composables/useLayeredEditorState";
import { useUiStore } from "@/stores/ui";

// ── State ────────────────────────────────────────────────────────────────────
const ui = useUiStore();
const resources   = ref<EditorResourceSummary[]>([]);
const selectedKey = ref<string | null>(null);
const model       = ref<EditorModel | null>(null);
const loading     = ref(false);
const saving      = ref(false);
const validating  = ref(false);
const saveMsg     = ref<{ ok: boolean; text: string } | null>(null);
const layout      = ref<InstanceType<typeof AppLayout> | null>(null);
const {
  draftValue,
  isLayered,
  baseValue,
  storedDraftValue,
  effectiveValue,
  isDirty
} = useLayeredEditorState(model);
const canSave     = computed(() => isDirty.value && !validating.value && !saving.value);
const canValidate = computed(() => !!model.value && !validating.value && !saving.value);

// ── Load list on mount ────────────────────────────────────────────────────────
onMounted(async () => {
  const res = await editorApi.list();
  resources.value = res.resources.filter((r) => r.domain === "config" && r.editable);
});

// ── Load model when selection changes ────────────────────────────────────────
watch(selectedKey, async (key) => {
  if (!key) { model.value = null; draftValue.value = null; return; }
  loading.value = true;
  saveMsg.value = null;
  try {
    const res = await editorApi.load(key);
    model.value = res.editor;
  } finally {
    loading.value = false;
  }
});

// ── Validate ──────────────────────────────────────────────────────────────────
async function validate() {
  if (!selectedKey.value || !model.value || !canValidate.value) return;
  validating.value = true;
  saveMsg.value = null;
  try {
    await editorApi.validate(selectedKey.value, draftValue.value);
    saveMsg.value = { ok: true, text: "验证通过" };
  } catch (e: unknown) {
    saveMsg.value = { ok: false, text: e instanceof Error ? e.message : "验证失败" };
  } finally {
    validating.value = false;
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function save() {
  if (!selectedKey.value || !model.value || !canSave.value) return;
  saving.value = true;
  saveMsg.value = null;
  try {
    const res = await editorApi.save(selectedKey.value, draftValue.value);
    saveMsg.value = { ok: true, text: `已保存 → ${res.path}` };
    const reloaded = await editorApi.load(selectedKey.value);
    model.value = reloaded.editor;
  } catch (e: unknown) {
    saveMsg.value = { ok: false, text: e instanceof Error ? e.message : "保存失败" };
  } finally {
    saving.value = false;
  }
}

async function reloadFromServer() {
  if (!selectedKey.value || !model.value || loading.value || saving.value || validating.value) return;
  loading.value = true;
  saveMsg.value = null;
  try {
    const res = await editorApi.load(selectedKey.value);
    model.value = res.editor;
  } finally {
    loading.value = false;
  }
}

function selectResource(key: string) {
  selectedKey.value = key;
  layout.value?.openDetail();
}

function updateDraft(value: unknown) {
  draftValue.value = value;
}
</script>

<template>
  <AppLayout ref="layout">
    <!-- ── Resource list ── -->
    <template #side>
      <div v-if="!ui.isMobile" class="panel-header flex h-10 shrink-0 items-center border-b px-3">
        <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">配置编辑器</span>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <button
          v-for="r in resources"
          :key="r.key"
          class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left"
          :class="{ 'is-selected': selectedKey === r.key }"
          @click="selectResource(r.key)"
        >
          <span class="text-ui text-text-secondary">{{ r.title }}</span>
          <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ r.kind }}</span>
        </button>
        <div v-if="resources.length === 0" class="px-3 py-6 text-center text-small text-text-subtle">暂无可编辑资源</div>
      </div>
    </template>

    <!-- ── Editor panel ── -->
    <template #main>
      <div class="flex h-full flex-col overflow-hidden">
        <!-- No selection -->
        <div v-if="!selectedKey" class="panel-empty flex flex-1 items-center justify-center gap-2">← 选择一个配置项</div>

        <!-- Loading -->
        <div v-else-if="loading" class="panel-empty flex flex-1 items-center justify-center gap-2">
          <RefreshCw :size="16" class="spin" :stroke-width="2" />
          <span>加载中…</span>
        </div>

        <!-- Editor -->
        <template v-else-if="model">
          <!-- Toolbar -->
          <header class="toolbar-header flex min-h-10 shrink-0 flex-wrap items-center gap-2.5 border-b px-4 py-1.5">
            <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ model.kind }}</span>
            <div v-if="model.kind === 'layered'" class="flex min-w-0 items-center gap-2 text-small text-text-muted">
              <span class="editor-layer-badge editor-layer-badge-local">本层</span>
              <span class="truncate">当前实例显式写入</span>
              <span class="editor-layer-badge editor-layer-badge-inherited">继承</span>
              <span class="truncate">来自全局配置</span>
            </div>
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

          <!-- Save/validation message -->
          <div
            v-if="saveMsg"
            class="mx-4 mt-3 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-small"
            :class="saveMsg.ok ? 'bg-surface-success text-success' : 'bg-surface-danger text-danger'"
          >
            <CheckCircle v-if="saveMsg.ok" :size="13" :stroke-width="2" />
            <AlertCircle v-else :size="13" :stroke-width="2" />
            {{ saveMsg.text }}
          </div>

          <!-- Schema tree editor -->
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

    <template #mobile-header>
      <span v-if="model" class="truncate text-ui font-medium text-text-secondary">{{ model.title }}</span>
    </template>
  </AppLayout>
</template>
