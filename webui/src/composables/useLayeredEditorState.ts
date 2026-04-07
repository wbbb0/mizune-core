import { computed, ref, watch, type Ref } from "vue";
import type { EditorModel, LayeredEditorModel, SingleEditorModel } from "@/api/editor";
import { computeEffectiveValue, deepEqual } from "@/utils/editorState";

export function useLayeredEditorState(model: Ref<EditorModel | null>) {
  const draftValue = ref<unknown>(null);

  function resetDraft(nextModel = model.value) {
    if (!nextModel) {
      draftValue.value = null;
      return;
    }
    draftValue.value = nextModel.kind === "layered"
      ? (nextModel as LayeredEditorModel).currentValue
      : (nextModel as SingleEditorModel).current;
  }

  watch(model, (nextModel) => {
    resetDraft(nextModel);
  }, { immediate: true });

  const isLayered = computed(() => model.value?.kind === "layered");
  const baseValue = computed(() => {
    if (!model.value) {
      return undefined;
    }
    return model.value.kind === "layered"
      ? (model.value as LayeredEditorModel).baseValue
      : undefined;
  });
  const storedDraftValue = computed(() => {
    if (!model.value) {
      return undefined;
    }
    return model.value.kind === "layered"
      ? (model.value as LayeredEditorModel).currentValue
      : (model.value as SingleEditorModel).current;
  });
  const effectiveValue = computed(() => {
    if (!model.value) {
      return undefined;
    }
    if (model.value.kind !== "layered") {
      return draftValue.value;
    }
    return computeEffectiveValue(baseValue.value, draftValue.value);
  });
  const isDirty = computed(() => !deepEqual(draftValue.value, storedDraftValue.value));

  return {
    draftValue,
    isLayered,
    baseValue,
    storedDraftValue,
    effectiveValue,
    isDirty,
    resetDraft
  };
}
