<script setup lang="ts">
import type { Component } from "vue";

export type SessionGlyphModel =
  | { kind: "text"; value: string }
  | { kind: "icon"; component: Component; size?: number; strokeWidth?: number };

withDefaults(defineProps<{
  glyph: SessionGlyphModel;
  toneClass: string;
  sizeClass?: string;
  textClass?: string;
}>(), {
  sizeClass: "h-6 w-6",
  textClass: "text-[11px] font-bold"
});
</script>

<template>
  <span class="flex items-center justify-center rounded-full border border-current" :class="[toneClass, sizeClass, textClass]">
    <component
      :is="glyph.component"
      v-if="glyph.kind === 'icon'"
      :size="glyph.size ?? 13"
      :stroke-width="glyph.strokeWidth ?? 2"
    />
    <span v-else>{{ glyph.value }}</span>
  </span>
</template>