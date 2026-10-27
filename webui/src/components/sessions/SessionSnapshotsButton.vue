<script setup lang="ts">
import { computed } from "vue";
import { Save } from "lucide-vue-next";
import { WorkbenchButton, useWorkbenchWindows } from "@workbench-kit/vue";
import ScenarioHostSnapshotDialogContent from "./ScenarioHostSnapshotDialogContent.vue";
import { createSessionWindowContext } from "./sessionWindowContext";

const props = defineProps<{ sessionId: string; sessionGenerating: boolean }>();
const emit = defineEmits<{ restored: [] }>();
const windows = useWorkbenchWindows();
const sessionGenerating = computed(() => props.sessionGenerating);
function openSnapshotsDialog() {
  const sessionId = props.sessionId;
  void windows.openDialog({
    title: "存档 / 读档",
    description: "保存当前会话及动态状态，或读取已有存档。固定角色设定仍使用当前配置。",
    size: "lg", modal: true, context: createSessionWindowContext(sessionId), footer: "close",
    blocks: [{
      kind: "component", component: ScenarioHostSnapshotDialogContent,
      props: { sessionId, sessionGenerating, onRestored: () => { if (props.sessionId === sessionId) emit("restored"); } }
    }]
  });
}
</script>

<template>
  <WorkbenchButton variant="ghost" :icon="Save" :icon-size="12" label="存档/读档" title="打开存档读档" class="text-small" @click="openSnapshotsDialog" />
</template>
