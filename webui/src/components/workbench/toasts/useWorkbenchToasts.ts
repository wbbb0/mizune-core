import { computed } from "vue";
import { useWorkbenchController, useWorkbenchControllerContext } from "../runtime/workbenchController.js";
export type { ToastItem, WorkbenchToastService } from "./toastService.js";
import type { WorkbenchToastService } from "./toastService.js";

const dynamicWorkbenchToasts: WorkbenchToastService = {
  items: computed(() => useWorkbenchController().toasts.items.value),
  push(input) {
    return useWorkbenchController().toasts.push(input);
  },
  dismiss(id) {
    useWorkbenchController().toasts.dismiss(id);
  }
};

export function useWorkbenchToasts() {
  return useWorkbenchControllerContext()?.toasts ?? dynamicWorkbenchToasts;
}
