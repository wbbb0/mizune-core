<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { WorkbenchButton } from "@workbench-kit/vue";
import { testProviderModel, type ModelProbeOperation, type ModelProbeResult } from "@/api/editor";

const props = defineProps<{ provider: Record<string, unknown>; model: Record<string, unknown> }>();
const operations: Array<{ value: ModelProbeOperation; label: string; description: string }> = [
  { value: "chat", label: "对话", description: "一句简短文本，限制输出长度。" },
  { value: "embedding", label: "向量", description: "一个短句的向量。" },
  { value: "transcription", label: "音频转写", description: "一小段测试音频，不读取聊天录音。" },
  { value: "decision", label: "原生决策", description: "一个简单的是非判断。" },
  { value: "speech", label: "语音生成", description: "生成“你好”，会产生语音调用费用。" },
  { value: "image", label: "图像生成", description: "实际生成一张简单图片，通常比文本测试费用高。" }
];
const selected = ref<ModelProbeOperation[]>(["chat", "embedding"]);
const running = ref(false);
const current = ref<ModelProbeOperation | null>(null);
const results = ref<ModelProbeResult[]>([]);
const stopped = ref(false);
const failure = ref("");
let controller: AbortController | null = null;
const labels = Object.fromEntries(operations.map(operation => [operation.value, operation.label]));
const resultLabels = { passed: "通过", unsupported: "当前接入未支持", inconclusive: "未确认" };
const selectedCount = computed(() => selected.value.length);
function toggle(operation: ModelProbeOperation) {
  if (running.value) return;
  selected.value = selected.value.includes(operation) ? selected.value.filter(value => value !== operation) : [...selected.value, operation];
}
async function run() {
  if (running.value || !selected.value.length) return;
  const active = new AbortController();
  controller = active;
  running.value = true;
  stopped.value = false;
  failure.value = "";
  results.value = [];
  try {
    for (const operation of [...selected.value]) {
      if (active.signal.aborted) break;
      current.value = operation;
      const result = await testProviderModel(props.provider, props.model, operation, active.signal);
      if (!active.signal.aborted) results.value.push(result);
    }
  } catch (error) {
    if (!active.signal.aborted) failure.value = error instanceof Error ? error.message : "测试请求失败";
  } finally {
    stopped.value = active.signal.aborted;
    if (controller === active) controller = null;
    running.value = false;
    current.value = null;
  }
}
function stop() { controller?.abort(); }
onBeforeUnmount(stop);
</script>

<template>
  <div class="flex min-h-0 flex-col gap-4 overflow-y-auto p-1">
    <p class="text-small text-text-muted">使用当前未保存的连接信息和模型名，每项只发送一次简单请求，不自动重试或切换模型。结果不会自动修改模型配置。</p>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label v-for="operation in operations" :key="operation.value" class="flex cursor-pointer items-start gap-2 rounded border border-border-subtle p-3">
        <input type="checkbox" class="mt-1 accent-accent" :checked="selected.includes(operation.value)" :disabled="running" @change="toggle(operation.value)" />
        <span class="flex flex-col gap-1">
          <span class="text-small font-medium text-text-primary">{{ operation.label }}</span>
          <span class="text-small text-text-muted">{{ operation.description }}</span>
        </span>
      </label>
    </div>
    <div class="flex items-center gap-2">
      <WorkbenchButton variant="primary" :disabled="running || !selectedCount" @click="run">{{ running ? `正在测试${current ? labels[current] : ''}…` : `开始测试（${selectedCount} 项）` }}</WorkbenchButton>
      <WorkbenchButton v-if="running" @click="stop">停止</WorkbenchButton>
      <span v-else-if="stopped" class="text-small text-text-muted">已停止测试。</span>
    </div>
    <p v-if="failure" role="alert" class="text-small text-danger">{{ failure }}</p>
    <div v-if="results.length" class="flex flex-col gap-2" aria-live="polite">
      <div v-for="result in results" :key="result.operation" class="rounded border border-border-subtle p-3">
        <div class="flex items-center justify-between gap-2 text-small">
          <span class="font-medium">{{ labels[result.operation] }}</span>
          <span :class="result.status === 'passed' ? 'text-success' : 'text-text-muted'">{{ resultLabels[result.status] }} · {{ (result.durationMs / 1000).toFixed(1) }} 秒</span>
        </div>
        <p class="mt-1 break-words text-small text-text-muted">{{ result.message }}</p>
      </div>
    </div>
    <p class="text-small text-text-subtle">一次成功只说明本次请求可用，不代表支持所有参数；网络、鉴权、限流和参数错误会标为“未确认”。媒体测试默认不勾选。</p>
  </div>
</template>
