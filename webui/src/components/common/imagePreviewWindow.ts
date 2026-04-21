import type { WindowDefinition, WindowResult } from "@/components/workbench/windows/types";
import ImagePreviewDialog from "./ImagePreviewDialog.vue";

type WindowOpener = {
  open<TValues extends Record<string, unknown>, TResult>(
    definition: WindowDefinition<TValues, TResult>
  ): Promise<WindowResult<TResult, TValues>>;
};

export function openImagePreviewWindow(
  windows: WindowOpener,
  input: {
    src: string;
    alt?: string;
    title?: string;
  }
) {
  return windows.open({
    kind: "dialog",
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
