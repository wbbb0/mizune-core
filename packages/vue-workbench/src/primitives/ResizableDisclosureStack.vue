<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import type { ResizableDisclosureLayout, ResizableDisclosureSection } from "./disclosureStackTypes";

const props = withDefaults(defineProps<{
  sections: readonly ResizableDisclosureSection[];
  minSectionSize?: number;
  defaultWeight?: number;
}>(), {
  minSectionSize: 72,
  defaultWeight: 1
});

const emit = defineEmits<{
  "update:layout": [layout: ResizableDisclosureLayout];
}>();

const sectionLayout = reactive<ResizableDisclosureLayout>({});
const resizing = ref<{
  previousSectionId: string;
  sectionId: string;
  startY: number;
  previousStartHeight: number;
  sectionStartHeight: number;
  previousStartWeight: number;
  sectionStartWeight: number;
  pointerId: number;
  handle: HTMLElement;
  moved: boolean;
} | null>(null);
const suppressHeaderClickSectionId = ref<string | null>(null);
const sectionContentElements = new Map<string, HTMLElement>();

const sectionIds = computed(() => props.sections.map((section) => section.id));
const expandedSectionIds = computed(() => sectionIds.value.filter((sectionId) => sectionLayout[sectionId]?.expanded));

watch(
  () => props.sections,
  (sections) => {
    const nextIds = new Set(sections.map((section) => section.id));
    for (const existingId of Object.keys(sectionLayout)) {
      if (!nextIds.has(existingId)) {
        delete sectionLayout[existingId];
        sectionContentElements.delete(existingId);
      }
    }
    for (const section of sections) {
      const existing = sectionLayout[section.id];
      if (existing) {
        continue;
      }
      sectionLayout[section.id] = {
        expanded: section.expanded ?? true,
        weight: normalizeWeight(section.weight, props.defaultWeight)
      };
    }
    emitLayout();
  },
  { immediate: true, deep: true }
);

function previousExpandedSectionId(sectionId: string): string | null {
  const index = expandedSectionIds.value.indexOf(sectionId);
  return index > 0 ? expandedSectionIds.value[index - 1] ?? null : null;
}

function canResizeSection(sectionId: string) {
  return Boolean(sectionLayout[sectionId]?.expanded && previousExpandedSectionId(sectionId));
}

function isExpanded(sectionId: string) {
  return sectionLayout[sectionId]?.expanded ?? true;
}

function toggleSection(sectionId: string) {
  const layout = sectionLayout[sectionId];
  if (!layout) {
    return;
  }
  layout.expanded = !layout.expanded;
  emitLayout();
}

function sectionContentStyle(sectionId: string) {
  if (expandedSectionIds.value.length <= 1) {
    return {
      flex: "1 1 auto",
      minHeight: `${props.minSectionSize}px`
    };
  }
  return {
    flex: `${sectionLayout[sectionId]?.weight ?? props.defaultWeight} 1 0`,
    minHeight: `${props.minSectionSize}px`
  };
}

function setSectionContentElement(sectionId: string, element: unknown) {
  if (element instanceof HTMLElement) {
    sectionContentElements.set(sectionId, element);
    return;
  }
  sectionContentElements.delete(sectionId);
}

function sectionContentRef(sectionId: string) {
  return (element: Element | null) => setSectionContentElement(sectionId, element);
}

function onSectionHeaderClick(sectionId: string) {
  if (suppressHeaderClickSectionId.value === sectionId) {
    suppressHeaderClickSectionId.value = null;
    return;
  }
  toggleSection(sectionId);
}

function startSectionResize(event: PointerEvent, sectionId: string) {
  if (event.button !== 0) {
    return;
  }
  if (!isExpanded(sectionId)) {
    return;
  }
  const previousSectionId = previousExpandedSectionId(sectionId);
  if (!previousSectionId) {
    return;
  }
  const previousElement = sectionContentElements.get(previousSectionId);
  const sectionElement = sectionContentElements.get(sectionId);
  if (!previousElement || !sectionElement) {
    return;
  }
  const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!handle) {
    return;
  }
  handle.setPointerCapture?.(event.pointerId);
  resizing.value = {
    previousSectionId,
    sectionId,
    startY: event.clientY,
    previousStartHeight: previousElement.getBoundingClientRect().height,
    sectionStartHeight: sectionElement.getBoundingClientRect().height,
    previousStartWeight: sectionLayout[previousSectionId]?.weight ?? props.defaultWeight,
    sectionStartWeight: sectionLayout[sectionId]?.weight ?? props.defaultWeight,
    pointerId: event.pointerId,
    handle,
    moved: false
  };
  window.addEventListener("pointermove", onSectionResize);
  window.addEventListener("pointerup", stopSectionResize, { once: true });
  window.addEventListener("pointercancel", stopSectionResize, { once: true });
  window.addEventListener("blur", stopSectionResize, { once: true });
}

function onSectionResize(event: PointerEvent) {
  const active = resizing.value;
  if (!active) {
    return;
  }
  const delta = event.clientY - active.startY;
  if (Math.abs(delta) >= 3) {
    active.moved = true;
    suppressHeaderClickSectionId.value = active.sectionId;
  }
  if (!active.moved) {
    return;
  }
  event.preventDefault();
  const totalHeight = active.previousStartHeight + active.sectionStartHeight;
  const totalWeight = active.previousStartWeight + active.sectionStartWeight;
  const minHeight = Math.min(props.minSectionSize, totalHeight / 2);
  const previousHeight = clamp(active.previousStartHeight + delta, minHeight, totalHeight - minHeight);
  const previousRatio = previousHeight / totalHeight;
  if (sectionLayout[active.previousSectionId]) {
    sectionLayout[active.previousSectionId].weight = roundWeight(totalWeight * previousRatio);
  }
  if (sectionLayout[active.sectionId]) {
    sectionLayout[active.sectionId].weight = roundWeight(totalWeight * (1 - previousRatio));
  }
  emitLayout();
}

function stopSectionResize() {
  const active = resizing.value;
  if (active?.handle.hasPointerCapture?.(active.pointerId)) {
    active.handle.releasePointerCapture(active.pointerId);
  }
  if (active?.moved) {
    window.setTimeout(() => {
      if (suppressHeaderClickSectionId.value === active.sectionId) {
        suppressHeaderClickSectionId.value = null;
      }
    }, 0);
  }
  resizing.value = null;
  window.removeEventListener("pointermove", onSectionResize);
  window.removeEventListener("pointerup", stopSectionResize);
  window.removeEventListener("pointercancel", stopSectionResize);
  window.removeEventListener("blur", stopSectionResize);
}

function emitLayout() {
  emit("update:layout", Object.fromEntries(
    Object.entries(sectionLayout).map(([sectionId, layout]) => [
      sectionId,
      { expanded: layout.expanded, weight: layout.weight }
    ])
  ));
}

function normalizeWeight(value: number | undefined, fallback: number) {
  const resolved = Number(value ?? fallback);
  return Number.isFinite(resolved) && resolved > 0 ? resolved : 1;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundWeight(value: number) {
  return Math.max(0.1, Math.round(value * 1000) / 1000);
}

onBeforeUnmount(() => {
  stopSectionResize();
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden" :class="{ 'cursor-row-resize select-none': resizing }">
    <template v-for="section in sections" :key="section.id">
      <button
        :id="`disclosure-stack-${section.id}-header`"
        :aria-controls="`disclosure-stack-${section.id}-content`"
        :aria-expanded="isExpanded(section.id)"
        class="flex h-8 w-full shrink-0 touch-none items-center gap-1.5 border-b border-border-subtle px-2 text-left text-small font-medium text-text-secondary hover:bg-surface-muted hover:text-text-primary"
        :class="{ 'cursor-row-resize': canResizeSection(section.id) }"
        type="button"
        @click="onSectionHeaderClick(section.id)"
        @pointerdown="startSectionResize($event, section.id)"
      >
        <slot
          name="header"
          :section="section"
          :expanded="isExpanded(section.id)"
          :can-resize="canResizeSection(section.id)"
          :resizing="resizing?.sectionId === section.id"
        >
          <span class="min-w-0 flex-1 truncate">{{ section.title ?? section.id }}</span>
        </slot>
      </button>

      <div
        v-if="isExpanded(section.id)"
        :id="`disclosure-stack-${section.id}-content`"
        :aria-labelledby="`disclosure-stack-${section.id}-header`"
        :ref="sectionContentRef(section.id)"
        class="min-h-0 overflow-hidden border-b border-border-subtle"
        role="region"
        :style="sectionContentStyle(section.id)"
      >
        <slot :section="section" />
      </div>
    </template>
  </div>
</template>
