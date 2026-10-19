<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { AlertCircle, Check, DownloadCloud, RefreshCw, Search } from "lucide-vue-next";
import {
  WorkbenchButton,
  WorkbenchCard,
  WorkbenchDataTable,
  WorkbenchEmptyState,
  WorkbenchFormField,
  WorkbenchMultiSelect,
  ResponsiveSplitPane,
  WorkbenchSelect,
  WorkbenchTabStrip,
  WorkbenchTextInput,
  type WorkbenchDataTableColumn,
  type WorkbenchMultiSelectOption,
  type WorkbenchTabStripItem
} from "@workbench-kit/vue";
import {
  listProviderModels,
  type LlmModelAddEntry,
  type ProviderModelListResult,
  type ProviderModelSlot
} from "@/api/editor";

interface LlmModelAddWindowProps {
  provider: Record<string, unknown>;
  existingAliases: string[];
  /** DialogRenderer 注入的响应式窗口值，用于驱动原生 footer action。 */
  values: Record<string, unknown>;
}

type AddMode = "catalog" | "manual";

interface ModelDraft {
  upstreamModel: string;
  alias: string;
  aliasTouched: boolean;
  capabilities: Record<string, string | boolean>;
}

const props = defineProps<LlmModelAddWindowProps>();

/** 与后端 createProviderModelCapabilityDraft 保持一致的能力默认值；修改时同步两侧。 */
function defaultCapabilitiesForProviderType(providerType: unknown): Record<string, string | boolean> {
  const capabilities: Record<string, string | boolean> = {
    modelType: "chat",
    supportsThinking: false,
    thinkingControllable: true,
    supportsVision: false,
    supportsAudioInput: false,
    supportsTools: true,
    preserveThinking: false
  };
  if (providerType !== "lmstudio" && providerType !== "anthropic") {
    capabilities.supportsSearch = false;
  }
  return capabilities;
}

function createEmptyDraft(): ModelDraft {
  return {
    upstreamModel: "",
    alias: "",
    aliasTouched: false,
    capabilities: defaultCapabilitiesForProviderType(props.provider.type)
  };
}

function slugifyAlias(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "model";
}

function uniqueAlias(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

const MODE_TABS: WorkbenchTabStripItem[] = [
  { id: "catalog", label: "从供应商清单选择", controls: "catalog-source-panel" },
  { id: "manual", label: "手动添加", controls: "manual-source-panel" }
];

const MODEL_TYPE_OPTIONS = [
  { value: "chat", label: "对话" },
  { value: "transcription", label: "转写" },
  { value: "image_generation", label: "生图" },
  { value: "embedding", label: "向量" }
];

const CAPABILITY_OPTIONS: Record<string, { label: string; description: string }> = {
  supportsThinking: { label: "思考", description: "模型可以生成思考内容" },
  thinkingControllable: { label: "思考可控", description: "请求可以控制是否启用思考" },
  supportsVision: { label: "视觉", description: "模型可以接收图片输入" },
  supportsAudioInput: { label: "音频输入", description: "模型可以接收音频输入" },
  supportsTools: { label: "工具调用", description: "模型可以发起工具调用" },
  supportsSearch: { label: "联网搜索", description: "模型支持供应商原生搜索" },
  preserveThinking: { label: "保留思考", description: "在后续请求中保留思考内容" }
};

const MODEL_COLUMNS: WorkbenchDataTableColumn<ProviderModelSlot>[] = [
  { key: "upstreamModel", title: "模型", width: "minmax(10rem, 1fr)", cellClass: "font-mono text-text-secondary" },
  { key: "status", title: "状态", width: "5rem" }
];

const usedAliases = new Set(props.existingAliases);
const mode = ref<AddMode>("catalog");
const catalogDraft = ref<ModelDraft>(createEmptyDraft());
const manualDraft = ref<ModelDraft>(createEmptyDraft());
const activeDraft = computed(() => mode.value === "catalog" ? catalogDraft.value : manualDraft.value);

const fetching = ref(false);
const fetchAttempted = ref(false);
const fetchError = ref<string | null>(null);
const fetched = ref<Extract<ProviderModelListResult, { kind: "ok" }> | null>(null);
const query = ref("");

const fetchedModels = computed(() => fetched.value?.models ?? []);
const filteredModels = computed(() => {
  const normalizedQuery = query.value.trim().toLowerCase();
  if (!normalizedQuery) {
    return fetchedModels.value;
  }
  return fetchedModels.value.filter(slot => (
    slot.upstreamModel.toLowerCase().includes(normalizedQuery)
    || slot.alias.toLowerCase().includes(normalizedQuery)
  ));
});
const newModelCount = computed(() => fetchedModels.value.filter(slot => !slot.exists).length);
const existingModelCount = computed(() => fetchedModels.value.length - newModelCount.value);

function selectModel(slot: ProviderModelSlot) {
  catalogDraft.value = {
    upstreamModel: slot.upstreamModel,
    alias: slot.alias,
    aliasTouched: false,
    capabilities: { ...slot.capabilities }
  };
}

async function fetchModels() {
  fetching.value = true;
  fetchAttempted.value = true;
  fetchError.value = null;
  const previousSelection = catalogDraft.value.upstreamModel;
  try {
    const result = await listProviderModels(props.provider);
    if (result.kind === "unsupported") {
      fetchError.value = result.reason;
      return;
    }
    fetched.value = result;
    const nextSelection = result.models.find(slot => slot.upstreamModel === previousSelection) ?? result.models[0];
    if (nextSelection) {
      selectModel(nextSelection);
    } else {
      catalogDraft.value = createEmptyDraft();
    }
  } catch (error: unknown) {
    fetchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    fetching.value = false;
  }
}

function findExistingModel(upstreamModel: string): { alias: string; profile: Record<string, unknown> } | null {
  const models = (props.provider.models ?? {}) as Record<string, Record<string, unknown>>;
  for (const [alias, profile] of Object.entries(models)) {
    if (profile.upstreamModel === upstreamModel) {
      return { alias, profile };
    }
  }
  return null;
}

function capabilitiesFromProfile(profile: Record<string, unknown>): Record<string, string | boolean> {
  const capabilities = defaultCapabilitiesForProviderType(props.provider.type);
  for (const key of Object.keys(capabilities)) {
    const value = profile[key];
    if (typeof value === "string" || typeof value === "boolean") {
      capabilities[key] = value;
    }
  }
  return capabilities;
}

function updateManualUpstreamModel(value: string) {
  const existing = findExistingModel(value.trim());
  manualDraft.value.upstreamModel = value;
  manualDraft.value.capabilities = existing
    ? capabilitiesFromProfile(existing.profile)
    : defaultCapabilitiesForProviderType(props.provider.type);
  if (existing) {
    manualDraft.value.alias = existing.alias;
    manualDraft.value.aliasTouched = false;
  } else if (!manualDraft.value.aliasTouched) {
    manualDraft.value.alias = uniqueAlias(slugifyAlias(value), usedAliases);
  }
}

function resetAliasAutoSync() {
  const existing = findExistingModel(activeDraft.value.upstreamModel.trim());
  activeDraft.value.aliasTouched = false;
  activeDraft.value.alias = existing?.alias
    ?? uniqueAlias(slugifyAlias(activeDraft.value.upstreamModel), usedAliases);
}

const existingUpstreamAlias = computed(() => (
  findExistingModel(activeDraft.value.upstreamModel.trim())?.alias ?? null
));

const aliasValid = computed(() => /^[a-z0-9_]+$/.test(activeDraft.value.alias.trim()));
const aliasCollidesWithExisting = computed(() => {
  const candidate = activeDraft.value.alias.trim();
  return aliasValid.value
    && props.existingAliases.includes(candidate)
    && existingUpstreamAlias.value !== candidate;
});
const aliasError = computed(() => {
  if (!activeDraft.value.alias.trim()) {
    return "请输入模型别名";
  }
  if (!aliasValid.value) {
    return "别名只能包含小写字母、数字和下划线";
  }
  if (aliasCollidesWithExisting.value) {
    return `别名 ${activeDraft.value.alias.trim()} 已被其他模型使用`;
  }
  return "";
});

const capabilityOptions = computed<WorkbenchMultiSelectOption[]>(() => (
  Object.keys(activeDraft.value.capabilities)
    .filter(key => key !== "modelType")
    .map(key => ({ value: key, ...(CAPABILITY_OPTIONS[key] ?? { label: key, description: "" }) }))
));
const selectedCapabilities = computed({
  get: () => Object.entries(activeDraft.value.capabilities)
    .filter(([key, value]) => key !== "modelType" && value === true)
    .map(([key]) => key),
  set: (selected: string[]) => {
    const selectedSet = new Set(selected);
    for (const key of Object.keys(activeDraft.value.capabilities)) {
      if (key !== "modelType" && typeof activeDraft.value.capabilities[key] === "boolean") {
        activeDraft.value.capabilities[key] = selectedSet.has(key);
      }
    }
  }
});
const canSubmit = computed(() => (
  activeDraft.value.upstreamModel.trim().length > 0
  && aliasValid.value
  && !aliasCollidesWithExisting.value
));
const isUpdating = computed(() => existingUpstreamAlias.value === activeDraft.value.alias.trim());

watch(
  [activeDraft, canSubmit, isUpdating],
  () => {
    props.values.entry = canSubmit.value
      ? {
          upstreamModel: activeDraft.value.upstreamModel.trim(),
          alias: activeDraft.value.alias.trim(),
          capabilities: { ...activeDraft.value.capabilities }
        } satisfies LlmModelAddEntry
      : undefined;
    props.values.canSubmit = canSubmit.value;
    props.values.updating = isUpdating.value;
  },
  { deep: true, immediate: true }
);

onMounted(() => {
  void fetchModels();
});
</script>

<template>
  <div class="flex min-h-0 flex-col gap-4">
    <WorkbenchTabStrip v-model="mode" :items="MODE_TABS" bordered />

    <ResponsiveSplitPane
      class="min-h-0 flex-1 basis-80"
      :breakpoint="620"
      :default-primary-size="350"
      :min-primary-size="240"
      :min-secondary-size="260"
      compact-mode="tabs"
      primary-title="模型来源"
      secondary-title="模型配置"
    >
      <template #primary="{ compact }">
        <section
          v-if="mode === 'catalog'"
          id="catalog-source-panel"
          class="flex h-full min-h-0 flex-col gap-3"
          :class="compact ? '' : 'pr-3'"
          role="tabpanel"
        >
          <div class="flex min-w-0 items-center gap-2">
            <WorkbenchFormField class="min-w-0 flex-1" for-id="model-search">
              <div class="relative">
                <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-subtle" />
                <WorkbenchTextInput id="model-search" v-model="query" class="pl-8" type="search" placeholder="搜索模型名或别名" :disabled="!fetchedModels.length" />
              </div>
            </WorkbenchFormField>
            <WorkbenchButton :icon="RefreshCw" :label="fetching ? '正在刷新' : '刷新'" :disabled="fetching" :class="fetching ? '[&_svg]:animate-spin' : ''" @click="fetchModels" />
          </div>

          <div v-if="fetched" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-text-subtle">
            <span>共 {{ fetchedModels.length }} 个</span>
            <span class="text-success">{{ newModelCount }} 个可添加</span>
            <span v-if="existingModelCount">{{ existingModelCount }} 个已配置</span>
            <span v-if="fetched.endpoint" class="min-w-0 flex-1 truncate text-right font-mono" :title="fetched.endpoint">{{ fetched.endpoint }}</span>
          </div>
          <div v-if="fetchError && fetched" class="flex items-start gap-2 rounded-md border border-danger/40 bg-surface-muted px-3 py-2 text-small text-danger">
            <AlertCircle class="mt-0.5 size-4 shrink-0" />
            刷新失败，当前仍显示上一次获取的结果：{{ fetchError }}
          </div>

          <WorkbenchCard class="flex min-h-40 flex-1 flex-col overflow-hidden" padding="none" surface="sidebar">
            <div v-if="fetching && !fetched" class="flex flex-1 items-center justify-center gap-2 text-text-muted">
              <RefreshCw class="size-4 animate-spin" />
              正在读取供应商模型清单…
            </div>
            <div v-else-if="fetchError" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertCircle class="size-6 text-danger" />
              <div>
                <p class="text-text-secondary">无法读取模型清单</p>
                <p class="mt-1 whitespace-pre-line text-small text-danger">{{ fetchError }}</p>
              </div>
              <WorkbenchButton :icon="DownloadCloud" label="重新获取" @click="fetchModels" />
            </div>
            <WorkbenchDataTable
              v-else-if="fetched"
              :rows="filteredModels"
              :columns="MODEL_COLUMNS"
              :get-row-key="slot => slot.upstreamModel"
              :selected-row-key="catalogDraft.upstreamModel || null"
              :empty-message="query ? '没有匹配的模型' : '供应商没有返回可用模型'"
              @select-row="selectModel"
            >
              <template #cell="{ row, column }">
                <template v-if="column.key === 'status'">
                  <span v-if="row.exists" class="rounded bg-surface-muted px-1.5 py-0.5 text-text-subtle">已配置</span>
                  <span v-else class="rounded bg-success/10 px-1.5 py-0.5 text-success">可添加</span>
                </template>
                <template v-else>{{ row.upstreamModel }}</template>
              </template>
            </WorkbenchDataTable>
            <WorkbenchEmptyState v-else-if="fetchAttempted" message="暂无模型" />
          </WorkbenchCard>
        </section>

        <section
          v-else
          id="manual-source-panel"
          class="scrollbar-thin flex h-full min-h-0 flex-col gap-3 overflow-y-auto"
          :class="compact ? '' : 'pr-3'"
          role="tabpanel"
        >
          <WorkbenchCard title="上游模型" surface="sidebar" padding="lg">
            <WorkbenchFormField label="模型名" for-id="manual-upstream-model" hint="填写供应商接口实际使用的模型 ID。" required>
              <WorkbenchTextInput id="manual-upstream-model" :model-value="manualDraft.upstreamModel" placeholder="例如 deepseek-chat" spellcheck="false" @update:model-value="updateManualUpstreamModel" />
            </WorkbenchFormField>
          </WorkbenchCard>
          <p class="text-small leading-5 text-text-subtle">仅在供应商不提供模型清单接口，或目标模型没有出现在清单中时使用手动添加。</p>
        </section>
      </template>

      <template #secondary="{ compact }">
        <div class="h-full min-h-0" :class="compact ? '' : 'pl-3'">
          <WorkbenchCard
            title="模型配置"
            class="scrollbar-thin flex h-full min-h-0 flex-col gap-4 overflow-y-auto"
            surface="sidebar"
            padding="lg"
          >
            <div v-if="!activeDraft.upstreamModel" class="flex min-h-28 flex-1 items-center justify-center text-center text-text-subtle">
              {{ mode === "catalog" ? "从模型来源选择一个模型后继续" : "填写上游模型名后继续" }}
            </div>
            <template v-else>
              <div class="min-w-0">
                <p class="text-small text-text-subtle">上游模型</p>
                <p class="mt-1 truncate font-mono text-text-primary" :title="activeDraft.upstreamModel">{{ activeDraft.upstreamModel }}</p>
              </div>

              <WorkbenchFormField label="模型别名" for-id="model-alias" :error="aliasError" hint="用于目录引用，只能包含小写字母、数字和下划线。" required>
                <div class="flex items-center gap-2">
                  <WorkbenchTextInput id="model-alias" v-model="activeDraft.alias" class="min-w-0 flex-1 font-mono" :disabled="Boolean(existingUpstreamAlias)" spellcheck="false" @update:model-value="activeDraft.aliasTouched = true" />
                  <WorkbenchButton label="重新生成" variant="ghost" :disabled="!activeDraft.upstreamModel || Boolean(existingUpstreamAlias)" @click="resetAliasAutoSync" />
                </div>
              </WorkbenchFormField>

              <WorkbenchFormField label="模型类型" for-id="model-type">
                <WorkbenchSelect id="model-type" v-model="activeDraft.capabilities.modelType as string" :options="MODEL_TYPE_OPTIONS" />
              </WorkbenchFormField>

              <WorkbenchFormField label="模型能力" hint="决定模型可接收的输入及可用功能，之后仍可在目录表单中调整。">
                <WorkbenchMultiSelect v-model="selectedCapabilities" :options="capabilityOptions" placeholder="选择模型能力" search-placeholder="搜索能力" empty-message="没有可配置的能力" />
              </WorkbenchFormField>

              <div v-if="isUpdating" class="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-muted px-3 py-2 text-small text-text-secondary">
                <Check class="mt-0.5 size-4 shrink-0 text-success" />
                此模型已配置，提交后会更新其类型与能力，并保留已有 API 参数和图像生成参数。
              </div>
            </template>
          </WorkbenchCard>
        </div>
      </template>
    </ResponsiveSplitPane>
  </div>
</template>
