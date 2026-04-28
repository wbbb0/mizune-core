import type { WorkbenchDialogDefinition, WorkbenchWindowResult } from "@/components/workbench/windows/types";
import ImagePreviewDialog from "./ImagePreviewDialog.vue";

type WindowOpener = {
  openDialog<TValues extends Record<string, unknown>, TResult>(
    definition: WorkbenchDialogDefinition<TValues, TResult>
  ): Promise<WorkbenchWindowResult<TResult, TValues>>;
};

export function openImagePreviewWindow(
  windows: WindowOpener,
  input: {
    src: string;
    alt?: string;
    title?: string;
  }
) {
  return windows.openDialog({
    title: input.title || input.alt || "图片预览",
    size: "full",
    blocks: [
      {
        kind: "component",
        component: ImagePreviewDialog,
        props: input
      }
    ]
  });
}
