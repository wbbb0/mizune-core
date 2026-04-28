import { useWorkbenchController } from "../runtime/workbenchController.js";
export type { WorkbenchRuntimeWindow, WorkbenchWindowManager } from "./windowService.js";

export function useWorkbenchWindows() {
  return useWorkbenchController().windows;
}
