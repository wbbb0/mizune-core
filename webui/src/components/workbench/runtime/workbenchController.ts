import {
  computed,
  defineComponent,
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
import { defineWorkbenchView, type WorkbenchView } from "../types.js";
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
let fallbackWorkbenchController: WorkbenchController | null = null;

const FallbackWorkbenchArea = defineComponent({
  name: "FallbackWorkbenchArea",
  setup: () => () => null
});

const fallbackWorkbenchView = defineWorkbenchView({
  id: "__fallback__",
  title: "",
  areas: {
    mainArea: FallbackWorkbenchArea
  }
});

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

function getFallbackWorkbenchController() {
  fallbackWorkbenchController ??= createWorkbenchController(computed(() => fallbackWorkbenchView));
  return fallbackWorkbenchController;
}

export function useWorkbenchController(): WorkbenchController {
  return useWorkbenchControllerContext()
    ?? activeWorkbenchController.value
    ?? getFallbackWorkbenchController();
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
