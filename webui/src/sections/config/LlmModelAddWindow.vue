<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DownloadCloud, RefreshCw } from "lucide-vue-next";
import { listProviderModels, type ProviderModelListResult } from "@/api/editor";
import type { WorkbenchWindowResult } from "@workbench-kit/vue";

interface LlmModelAddWindowProps {
  /** 当前 provider 草稿（含连接信息与已有 models）。 */
  provider: Record<string, unknown>;
  /** 已有模型别名，用于别名去重。 */
  existingAliases: string[];
  /** 当前 workbench 窗口 id（block 注入）。 */
  windowId: string;
  /** 关闭窗口并把结果交给调用方。 */
  closeWindow: (windowId: string, result: WorkbenchWindowResult) => void;
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
  // lmstudio / anthropic 在 llmProviderDefinitions 中 search 为 none，不提供联网搜索开关。
  if (providerType !== "lmstudio" && providerType !== "anthropic") {
    capabilities.supportsSearch = false;
  }
  return capabilities;
}

function slugifyAlias(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "model";
}

function uniqueAlias(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) {
    return base;
  }
  let candidate = "";
  for (let index = 2; ; index += 1) {
    candidate = `${base}_${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

const CAPABILITY_LABELS: Record<string, string> = {
  supportsThinking: "思考",
  thinkingControllable: "思考可控",
  supportsVision: "视觉",
  supportsAudioInput: "音频输入",
  supportsTools: "工具",
  supportsSearch: "联网搜索",
  preserveThinking: "保留思考"
};

const MODEL_TYPE_OPTIONS = [
  { value: "chat", label: "对话" },
  { value: "transcription", label: "转写" },
  { value: "image_generation", label: "生图" },
  { value: "embedding", label: "向量" }
];

const providerType = computed(() => props.provider.type);

const mode = ref<"list" | "manual">("list");
const fetching = ref(false);
const fetchError = ref<string | null>(null);
const fetched = ref<ProviderModelListResult | null>(null);
const selectedIndex = ref(-1);

/** 已识别为同名已导入模型时记录其别名，提交即更新该条目。 */
const existingUpstreamAlias = ref<string | null>(null);
const upstreamModel = ref("");
const alias = ref("");
const aliasTouched = ref(false);
const capabilities = ref<Record<string, string | boolean>>(
  defaultCapabilitiesForProviderType(providerType.value)
);
const usedAliases = new Set(props.existingAliases);

function applyCapabilityDefaults(overrides?: Record<string, string | boolean>) {
  const base = defaultCapabilitiesForProviderType(providerType.value);
  capabilities.value = overrides
    ? { ...base, ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "modelType")) }
    : base;
}

function selectModelByIndex(index: number) {
  const slot = fetched.value?.kind === "ok" ? fetched.value.models[index] : undefined;
  if (!slot) {
    return;
  }
  selectedIndex.value = index;
  upstreamModel.value = slot.upstreamModel;
  existingUpstreamAlias.value = slot.exists ? slot.alias : null;
  if (slot.exists) {
    alias.value = slot.alias;
    aliasTouched.value = false;
  } else if (!aliasTouched.value) {
    alias.value = slot.alias;
  }
  const usableCapabilities = slot.capabilities as Record<string, string | boolean> | undefined;
  applyCapabilityDefaults(usableCapabilities);
}

watch(fetched, (next) => {
  if (next?.kind === "ok" && next.models.length > 0 && selectedIndex.value < 0) {
    selectModelByIndex(0);
  }
});

function switchMode(next: "list" | "manual") {
  if (mode.value === next) {
    return;
  }
  mode.value = next;
  fetchError.value = null;
  if (next === "manual" && !upstreamModel.value) {
    existingUpstreamAlias.value = null;
  }
}

function onUpstreamInput() {
  if (!aliasTouched.value) {
    alias.value = uniqueAlias(slugifyAlias(upstreamModel.value), usedAliases);
  }
}

/** 重新从上游模型名生成别名，并恢复“上游变化时自动同步别名”的联动。 */
function resetAliasAutoSync() {
  aliasTouched.value = false;
  onUpstreamInput();
}

const aliasValid = computed(() => /^[a-z0-9_]+$/.test(alias.value.trim()));
const canSubmit = computed(() => upstreamModel.value.trim().length > 0 && aliasValid.value);

async function fetchModels() {
  fetching.value = true;
  fetchError.value = null;
  try {
    const result = await listProviderModels(props.provider);
    if (result.kind === "unsupported") {
      fetchError.value = result.reason;
      fetched.value = null;
      return;
    }
    fetched.value = result;
    if (result.models.length === 0) {
      fetchError.value = "接口返回空的模型清单，可切换到手动填写。";
    }
  } catch (error: unknown) {
    fetchError.value = error instanceof Error ? error.message : String(error);
    fetched.value = null;
  } finally {
    fetching.value = false;
  }
}

function cancel() {
  props.closeWindow(props.windowId, {
    reason: "dismiss",
    values: {}
  });
}

function submit() {
  if (!canSubmit.value) {
    return;
  }
  props.closeWindow(props.windowId, {
    reason: "action",
    actionId: "add",
    values: {},
    result: {
      upstreamModel: upstreamModel.value.trim(),
      alias: alias.value.trim(),
      capabilities: { ...capabilities.value }
    }
  });
}

const capabilityKeys = computed(() => Object.entries(CAPABILITY_LABELS));
const fetchedOptions = computed(() => fetched.value?.kind === "ok" ? fetched.value.models : []);
</script>

<template>
  <div class="flex min-h-0 flex-col gap-4">
    <div class="flex gap-1.5">
      <button
        class="btn btn-secondary flex-1"
        :class="mode === 'list' ? 'ring-1 ring-border-default' : ''"
        type="button"
        @click="switchMode('list')"
      >
        从清单选择
      </button>
      <button
        class="btn btn-secondary flex-1"
        :class="mode === 'manual' ? 'ring-1 ring-border-default' : ''"
        type="button"
        @click="switchMode('manual')"
      >
        手动填写
      </button>
    </div>

    <div v-if="mode === 'list'" class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <button class="btn btn-secondary shrink-0" type="button" :disabled="fetching" @click="fetchModels">
          <RefreshCw v-if="fetching" :size="13" class="spin" :stroke-width="2" />
          <DownloadCloud v-else :size="13" :stroke-width="1.8" />
          {{ fetching ? "获取中…" : "获取模型清单" }}
        </button>
        <span v-if="fetched?.kind === 'ok' && fetched.endpoint" class="truncate font-mono text-small text-text-muted">
          {{ fetched.endpoint }}
        </span>
      </div>
      <p v-if="fetchError" class="whitespace-pre-line text-small leading-5 text-danger">⚠ {{ fetchError }}</p>
      <label v-if="fetchedOptions.length > 0" class="flex flex-col gap-1 text-small text-text-muted">
        上游模型
        <select v-model.number="selectedIndex" class="input-base text-ui" @change="selectModelByIndex(selectedIndex)">
          <option
            v-for="(slot, index) in fetchedOptions"
            :key="slot.upstreamModel"
            :value="index"
          >
            {{ slot.upstreamModel }}{{ slot.exists ? ` · 已存在（${slot.alias}，提交将更新）` : "" }}
          </option>
        </select>
      </label>
    </div>

    <label v-else class="flex flex-col gap-1 text-small text-text-muted">
      上游模型名
      <input
        v-model="upstreamModel"
        class="input-base text-ui"
        type="text"
        placeholder="如 deepseek-chat"
        @input="onUpstreamInput"
      />
    </label>

    <label class="flex flex-col gap-1 text-small text-text-muted">
      模型别名<template v-if="aliasValid">（{{ alias.length }} 字符）</template>
      <div class="flex items-center gap-2">
        <input
          v-model="alias"
          class="input-base font-mono text-ui"
          type="text"
          :class="aliasValid ? '' : 'border-danger'"
          spellcheck="false"
          @input="aliasTouched = true"
        />
        <button class="btn btn-ghost shrink-0" type="button" :disabled="!upstreamModel" @click="resetAliasAutoSync">
          重新生成
        </button>
      </div>
      <span v-if="!aliasValid" class="text-small text-danger">别名只能包含小写字母、数字和下划线。</span>
    </label>

    <p v-if="existingUpstreamAlias" class="rounded border border-border-subtle bg-surface-sidebar px-3 py-2 text-small text-text-secondary">
      该上游模型已存在于别名 <span class="font-mono">{{ existingUpstreamAlias }}</span>，提交将更新其能力配置。
    </p>

    <fieldset class="rounded border border-border-default bg-surface-sidebar px-3 py-3">
      <legend class="px-1 text-small font-medium text-text-secondary">能力（可稍后在表单中修改）</legend>
      <div class="flex flex-col gap-3">
        <label class="flex items-center gap-2 text-small text-text-muted">
          类型
          <select v-model="capabilities.modelType" class="input-base min-h-7 text-ui">
            <option v-for="option in MODEL_TYPE_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <div class="flex flex-wrap gap-x-4 gap-y-2">
          <label
            v-for="[key, label] in capabilityKeys"
            :key="key"
            v-show="key in capabilities"
            class="flex items-center gap-1.5 text-small text-text-muted"
          >
            <input
              v-model="capabilities[key]"
              class="size-4 shrink-0 accent-[var(--accent)]"
              type="checkbox"
            />
            <span>{{ label }}</span>
          </label>
        </div>
      </div>
    </fieldset>

    <div class="flex items-center justify-end gap-2 border-t border-border-default pt-3">
      <button class="btn btn-secondary" type="button" @click="cancel">取消</button>
      <button class="btn btn-primary" type="button" :disabled="!canSubmit" @click="submit">
        添加模型
      </button>
    </div>
  </div>
</template>