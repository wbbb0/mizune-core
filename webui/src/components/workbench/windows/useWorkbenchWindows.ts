import { computed } from "vue";
import { useWorkbenchController } from "../runtime/workbenchController.js";
export type { WorkbenchRuntimeWindow, WorkbenchWindowManager } from "./windowService.js";
import type { WorkbenchWindowManager } from "./windowService.js";

const dynamicWorkbenchWindows: WorkbenchWindowManager = {
  desktopWindows: computed(() => useWorkbenchController().windows.desktopWindows.value),
  mobileWindows: computed(() => useWorkbenchController().windows.mobileWindows.value),
  openSync(definition) {
    return useWorkbenchController().windows.openSync(definition);
  },
  open(definition) {
    return useWorkbenchController().windows.open(definition);
  },
  openDialogSync(definition) {
    return useWorkbenchController().windows.openDialogSync(definition);
  },
  openDialog(definition) {
    return useWorkbenchController().windows.openDialog(definition);
  },
  focus(windowId) {
    return useWorkbenchController().windows.focus(windowId);
  },
  move(windowId, position) {
    return useWorkbenchController().windows.move(windowId, position);
  },
  close(windowId, result) {
    useWorkbenchController().windows.close(windowId, result);
  },
  closeByContext(context, result) {
    useWorkbenchController().windows.closeByContext(context, result);
  },
  get(windowId) {
    return useWorkbenchController().windows.get(windowId);
  },
  snapshot() {
    return useWorkbenchController().windows.snapshot();
  },
  visibleStack(mode) {
    return useWorkbenchController().windows.visibleStack(mode);
  }
};

export function useWorkbenchWindows() {
  return dynamicWorkbenchWindows;
}
