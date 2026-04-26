import { computed, effectScope, ref, watch, type ComputedRef, type Ref } from "vue";
import type { EditorModel } from "@/api/editor";
import { computeDraftEffectiveValue, computeDraftReferenceValue, deepEqual } from "@/utils/editorState";

type EditorDraftState = {
  draftValue: Ref<unknown>;
  referenceValue: ComputedRef<unknown>;
  storedDraftValue: ComputedRef<unknown>;
  effectiveValue: ComputedRef<unknown>;
  isDirty: ComputedRef<boolean>;
  resetDraft: (nextModel?: EditorModel | null) => void;
};

export function useEditorDraftState(model: Ref<EditorModel | null>): EditorDraftState {
  const scope = effectScope(true);
  let state: EditorDraftState | null = null;

  scope.run(() => {
    const draftValue = ref<unknown>(null);

    function resetDraft(nextModel = model.value) {
      if (!nextModel) {
        draftValue.value = null;
        return;
      }
      draftValue.value = nextModel.currentValue;
    }

    watch(model, (nextModel) => {
      resetDraft(nextModel);
    }, { immediate: true });

    const referenceValue = computed(() => {
      if (!model.value) {
        return undefined;
      }
      return computeDraftReferenceValue(model.value, draftValue.value);
    });
    const storedDraftValue = computed(() => model.value?.currentValue);
    const effectiveValue = computed(() => {
      if (!model.value) {
        return undefined;
      }
      return computeDraftEffectiveValue(model.value, draftValue.value);
    });
    const isDirty = computed(() => !deepEqual(draftValue.value, storedDraftValue.value));

    state = {
      draftValue,
      referenceValue,
      storedDraftValue,
      effectiveValue,
      isDirty,
      resetDraft
    };
  });

  return state!;
}
