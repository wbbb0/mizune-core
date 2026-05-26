<script setup lang="ts">
import type { Component } from "vue";

withDefaults(defineProps<{
  icon?: Component;
  label?: string;
  title?: string;
  disabled?: boolean;
  active?: boolean;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary";
  iconSize?: number;
  strokeWidth?: number;
  type?: "button" | "submit" | "reset";
}>(), {
  icon: undefined,
  label: "",
  title: "",
  disabled: false,
  active: false,
  size: "md",
  variant: "ghost",
  iconSize: 14,
  strokeWidth: 2,
  type: "button"
});

defineEmits<{
  click: [event: MouseEvent];
}>();
</script>

<template>
  <button
    :type="type"
    :title="title || label"
    :aria-label="label || title"
    :aria-pressed="active || undefined"
    :disabled="disabled"
    :class="[
      variant === 'ghost' ? 'btn-ghost' : 'btn btn-secondary',
      size === 'sm' ? 'h-7 w-7' : '',
      active ? 'bg-surface-selected-muted text-text-secondary' : ''
    ]"
    @click="$emit('click', $event)"
  >
    <slot>
      <component
        v-if="icon"
        :is="icon"
        :size="iconSize"
        :stroke-width="strokeWidth"
      />
    </slot>
  </button>
</template>
