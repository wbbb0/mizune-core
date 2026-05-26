<script setup lang="ts" generic="TItem">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  items: readonly TItem[];
  labelWidth?: string;
  compact?: boolean;
  getKey?: (item: TItem, index: number) => string | number;
  getLabel?: (item: TItem) => string;
}>(), {
  labelWidth: "8rem",
  compact: false,
  getKey: undefined,
  getLabel: undefined
});

const gridStyle = computed(() => props.compact
  ? undefined
  : { gridTemplateColumns: `${props.labelWidth} minmax(0, 1fr)` });

function itemKey(item: TItem, index: number): string | number {
  return typeof item === "object" && item !== null && "key" in item && typeof item.key === "string"
    ? item.key
    : index;
}

function itemLabel(item: TItem): string {
  if (typeof item === "object" && item !== null) {
    const record = item as Record<string, unknown>;
    return String(record.title ?? record.label ?? record.key ?? "");
  }
  return String(item ?? "");
}
</script>

<template>
  <dl
    class="grid gap-x-3 gap-y-2 text-small"
    :class="{ 'grid-cols-1': compact }"
    :style="gridStyle"
  >
    <template v-for="(item, index) in items" :key="getKey ? getKey(item, index) : itemKey(item, index)">
      <dt class="font-mono text-text-subtle">
        <slot name="label" :item="item" :index="index">
          {{ getLabel ? getLabel(item) : itemLabel(item) }}
        </slot>
      </dt>
      <dd class="min-w-0">
        <slot name="value" :item="item" :index="index" />
      </dd>
    </template>
  </dl>
</template>
