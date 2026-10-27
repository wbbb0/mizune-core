<script setup lang="ts">
import { computed } from "vue";
import { WorkbenchCard, WorkbenchDataTable, WorkbenchEmptyState, WorkbenchKeyValueDetails } from "@workbench-kit/vue";
import { scalarText, schemaEntries, type StateSchema } from "./statefulRpView";

const props = withDefaults(defineProps<{ value: unknown; schema?: StateSchema; compact?: boolean }>(), { schema: () => ({}), compact: false });
const objectValue = computed(() => props.value !== null && typeof props.value === "object" && !Array.isArray(props.value) ? props.value as Record<string, unknown> : null);
const entries = computed(() => objectValue.value ? schemaEntries(objectValue.value, props.schema) : []);
const rows = computed(() => Array.isArray(props.value) ? props.value.map((value, index) => ({ index, value })) : []);
const columns = [{ key: "index", title: "序号", width: "3rem" }, { key: "value", title: "内容", width: "minmax(0,1fr)" }];
</script>

<template>
  <WorkbenchEmptyState v-if="value == null || value === ''" :centered="false" message="未指定" class="text-small text-text-subtle" />
  <template v-else-if="Array.isArray(value)">
    <WorkbenchDataTable :rows="rows" :columns="columns" :stacked="compact" empty-message="暂无条目" :get-row-key="row => row.index" class="flex-none">
      <template #cell="{ row, column }">
        <span v-if="column.key === 'index'" class="text-text-subtle">{{ row.index + 1 }}</span>
        <div v-else class="whitespace-normal wrap-break-word py-1 text-text-secondary">
          <StatefulRpValue :value="row.value" :schema="schema.items" :compact="compact" />
        </div>
      </template>
    </WorkbenchDataTable>
  </template>
  <WorkbenchKeyValueDetails v-else-if="objectValue" :items="entries" :compact="compact" label-width="9rem">
    <template #label="{ item }"><span class="font-sans whitespace-normal wrap-break-word">{{ item.label }}</span></template>
    <template #value="{ item }">
      <WorkbenchCard v-if="item.value && typeof item.value === 'object'" padding="sm" surface="muted">
        <StatefulRpValue :value="item.value" :schema="item.schema" :compact="compact" />
      </WorkbenchCard>
      <span v-else class="whitespace-pre-wrap wrap-break-word text-text-secondary">{{ scalarText(item.value, item.schema) }}</span>
    </template>
  </WorkbenchKeyValueDetails>
  <span v-else class="whitespace-pre-wrap wrap-break-word text-small text-text-secondary">{{ scalarText(value, schema) }}</span>
</template>
