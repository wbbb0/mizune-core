<script setup lang="ts">
import { WorkbenchFormField, WorkbenchSelect, WorkbenchTextInput } from "@workbench-kit/vue";
const profile = defineModel<Record<string, unknown>>({ required: true });
defineProps<{ operations: string[] }>();
const capabilityLabels: Record<string, string> = {
  supportsVision: "图片输入", supportsAudioInput: "音频输入", supportsTools: "工具调用",
  supportsThinking: "思考", thinkingControllable: "可关闭思考", supportsSearch: "原生搜索"
};
const booleanOptions = [{ value: "unknown", label: "未知" }, { value: "true", label: "支持" }, { value: "false", label: "不支持" }];
const limitLabels: Record<string, string> = { contextTokens: "上下文总上限", maxInputTokens: "输入上限", maxOutputTokens: "输出上限" };
function read(operation: string, group: string, key: string): unknown {
  return ((profile.value[operation] as Record<string, unknown>)?.[group] as Record<string, unknown>)?.[key];
}
function write(operation: string, group: string, key: string, value: unknown) {
  const settings = { ...(profile.value[operation] as Record<string, unknown>) };
  const fields = { ...(settings[group] as Record<string, unknown>) };
  if (value === undefined) delete fields[key]; else fields[key] = value;
  profile.value = { ...profile.value, [operation]: { ...settings, [group]: fields } };
}
function writeLimit(operation: string, key: string, raw: string) {
  const value = Number(raw);
  write(operation, "limits", key, Number.isSafeInteger(value) && value > 0 ? value : undefined);
}
</script>
<template>
  <section v-for="operation in operations" :key="operation" class="flex flex-col gap-3 border-t border-border-subtle pt-3">
    <template v-if="operation === 'chat' || operation === 'transcription'">
      <p v-if="operation === 'transcription'" class="text-small text-text-subtle">转写通过聊天音频输入协议调用，不使用独立转写接口。</p>
      <div class="grid grid-cols-2 gap-3">
        <WorkbenchFormField v-for="(label, key) in capabilityLabels" :key="key" :label="label">
          <WorkbenchSelect :model-value="read(operation, 'capabilities', key) === undefined ? 'unknown' : String(read(operation, 'capabilities', key))" :options="booleanOptions" @update:model-value="value => write(operation, 'capabilities', key, value === 'unknown' ? undefined : value === 'true')" />
        </WorkbenchFormField>
      </div>
      <WorkbenchFormField v-for="(label, key) in limitLabels" :key="key" :label="label">
        <WorkbenchTextInput :model-value="String(read(operation, 'limits', key) ?? '')" type="number" placeholder="未知 / 未设置" @update:model-value="value => writeLimit(operation, key, value)" />
      </WorkbenchFormField>
    </template>
    <template v-else-if="operation === 'embedding'">
      <WorkbenchFormField label="输入上限">
        <WorkbenchTextInput :model-value="String(read(operation, 'limits', 'maxInputTokens') ?? '')" type="number" placeholder="未知 / 未设置" @update:model-value="value => writeLimit(operation, 'maxInputTokens', value)" />
      </WorkbenchFormField>
      <p class="text-small text-text-subtle">保存后可在向量配置中选择输入处理方式、查询任务说明与请求维度。</p>
    </template>
    <p v-else class="text-small text-text-subtle">图像工具使用独立 Images 接口，生成单张非流式图片。已发现的参数范围会保存在目录中，可在目录表单中调整默认参数。</p>
  </section>
</template>
