import { computed, ref } from "vue";
import type { WindowContext, WindowDefinition, WindowResult } from "@/components/workbench/windows/types";
import { createWindowManager } from "./windowManager";

type WindowManagerMode = "desktop" | "mobile";

export type WorkbenchRuntimeWindow = {
  id: string;
  order: number;
  parentId?: string;
  position: {
    x: number;
    y: number;
  };
  definition: WindowDefinition;
};

type WindowManagerFacade = {
  manager: ReturnType<typeof createWindowManager>;
  desktopWindows: Readonly<{ value: WorkbenchRuntimeWindow[] }>;
  mobileWindows: Readonly<{ value: WorkbenchRuntimeWindow[] }>;
  openSync<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WindowDefinition<TValues, TResult>
  ): WorkbenchRuntimeWindow;
  open<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WindowDefinition<TValues, TResult>
  ): Promise<WindowResult<TResult, TValues>>;
  focus(windowId: string): WorkbenchRuntimeWindow | undefined;
  move(windowId: string, position: { x: number; y: number }): WorkbenchRuntimeWindow | undefined;
  close<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    windowId: string,
    result: WindowResult<TResult, TValues>
  ): void;
  closeByContext(context: WindowContext, result?: WindowResult): void;
  get(windowId: string): WorkbenchRuntimeWindow | undefined;
  snapshot(): WorkbenchRuntimeWindow[];
  visibleStack(mode: WindowManagerMode): WorkbenchRuntimeWindow[];
};

const manager = createWindowManager();
const revision = ref(0);

function touch() {
  revision.value += 1;
}

const desktopWindows = computed<WorkbenchRuntimeWindow[]>(() => {
  revision.value;
  return manager.snapshot() as WorkbenchRuntimeWindow[];
});

const mobileWindows = computed<WorkbenchRuntimeWindow[]>(() => {
  revision.value;
  return manager.visibleStack("mobile") as WorkbenchRuntimeWindow[];
});

const sharedWorkbenchWindows: WindowManagerFacade = {
  manager,
  desktopWindows,
  mobileWindows,
  openSync(definition) {
    const window = manager.openSync(definition) as WorkbenchRuntimeWindow;
    touch();
    return window;
  },
  open(definition) {
    const result = manager.open(definition);
    touch();
    return result;
  },
  focus(windowId) {
    const window = manager.focus(windowId) as WorkbenchRuntimeWindow | undefined;
    touch();
    return window;
  },
  move(windowId, position) {
    const window = manager.move(windowId, position) as WorkbenchRuntimeWindow | undefined;
    touch();
    return window;
  },
  close(windowId, result) {
    manager.close(windowId, result);
    touch();
  },
  closeByContext(context, result) {
    manager.closeByContext(context, result);
    touch();
  },
  get(windowId) {
    return manager.get(windowId) as WorkbenchRuntimeWindow | undefined;
  },
  snapshot() {
    revision.value;
    return manager.snapshot() as WorkbenchRuntimeWindow[];
  },
  visibleStack(mode) {
    revision.value;
    return manager.visibleStack(mode) as WorkbenchRuntimeWindow[];
  }
};

export function useWorkbenchWindows() {
  return sharedWorkbenchWindows;
}
