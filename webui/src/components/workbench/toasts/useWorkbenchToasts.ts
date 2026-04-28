import { useWorkbenchController } from "../runtime/workbenchController.js";
export type { ToastItem, WorkbenchToastService } from "./toastService.js";

export function useWorkbenchToasts() {
  return useWorkbenchController().toasts;
}
