import { useWorkbenchController } from "../runtime/workbenchController.js";
export { SUBMENU_ACTIVATION_DELAY_MS, SUBMENU_HOVER_DELAY_MS } from "./menuRuntime.js";
export type { WorkbenchMenuRuntime } from "./menuRuntime.js";

export function useMenuRuntime() {
  return useWorkbenchController().menu;
}
