import {
  getCurrentInstance,
  inject,
  provide,
  shallowRef,
  type ComputedRef,
  type InjectionKey,
  type ShallowRef
} from "vue";
import { createMenuRuntime, type WorkbenchMenuRuntime } from "../menu/menuRuntime.js";
import { createWorkbenchToastService, type WorkbenchToastService } from "../toasts/toastService.js";
import { createWorkbenchWindowService, type WorkbenchWindowManager } from "../windows/windowService.js";
import type { WorkbenchView } from "../types.js";
import {
  activateWorkbenchRuntime,
  createWorkbenchRuntime,
  provideWorkbenchRuntime,
  type WorkbenchRuntime
} from "./workbenchRuntime.js";

export type WorkbenchController = {
  runtime: WorkbenchRuntime;
  menu: WorkbenchMenuRuntime;
  toasts: WorkbenchToastService;
  windows: WorkbenchWindowManager;
};

const workbenchControllerKey: InjectionKey<WorkbenchController> = Symbol("workbench-controller");
const activeWorkbenchController = shallowRef<WorkbenchController | null>(null);

export function createWorkbenchController(view: ComputedRef<WorkbenchView>): WorkbenchController {
  return {
    runtime: createWorkbenchRuntime(view),
    menu: createMenuRuntime(),
    toasts: createWorkbenchToastService(),
    windows: createWorkbenchWindowService()
  };
}

export function provideWorkbenchController(controller: WorkbenchController): void {
  provide(workbenchControllerKey, controller);
  provideWorkbenchRuntime(controller.runtime);
}

export function useWorkbenchControllerContext(): WorkbenchController | null {
  if (!getCurrentInstance()) {
    return null;
  }
  return inject(workbenchControllerKey, null);
}

export function useWorkbenchController(): WorkbenchController {
  const controller = useWorkbenchControllerContext() ?? activeWorkbenchController.value;
  if (!controller) {
    throw new Error("Workbench controller is not active. Mount WorkbenchRoot before using workbench services.");
  }
  return controller;
}

export function activateWorkbenchController(controller: WorkbenchController): () => void {
  const previousController = activeWorkbenchController.value;
  activeWorkbenchController.value = controller;
  const deactivateRuntime = activateWorkbenchRuntime(controller.runtime);
  return () => {
    if (activeWorkbenchController.value === controller) {
      activeWorkbenchController.value = previousController;
    }
    deactivateRuntime();
  };
}

export function useActiveWorkbenchController(): ShallowRef<WorkbenchController | null> {
  return activeWorkbenchController;
}
