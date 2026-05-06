import { createResourceEditorState, type ResourceEditorState } from "@llm-onebot/vue-resource-editor";
import { useWorkbenchNavigation, useWorkbenchToasts } from "@llm-onebot/vue-workbench";
import { editorApi, type EditorModel, type EditorResourceSummary, type LayeredEditorModel, type SingleEditorModel } from "@/api/editor";
import { createSharedSectionState } from "@/composables/sections/sharedSectionState";

export const useConfigSection = createSharedSectionState<ResourceEditorState>(() => {
  const toast = useWorkbenchToasts();
  const workbenchNavigation = useWorkbenchNavigation();

  return createResourceEditorState({
    client: editorApi,
    domain: "config",
    editableOnly: true,
    onSelect: () => workbenchNavigation.showArea("mainArea"),
    notify: (notification) => toast.push(notification),
    saveSuccessMessage: (path) => `已保存 → ${path}`
  });
});

export type { EditorResourceSummary, EditorModel, LayeredEditorModel, SingleEditorModel };
