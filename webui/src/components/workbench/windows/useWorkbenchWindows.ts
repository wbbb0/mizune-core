import { computed, ref } from "vue";
import type {
  WorkbenchDialogDefinition,
  WorkbenchWindowContext,
  WorkbenchWindowDefinition,
  WorkbenchWindowResult
} from "@/components/workbench/windows/types";
import { createWindowManager } from "./windowManager";

type WorkbenchWindowMode = "desktop" | "mobile";

export type WorkbenchRuntimeWindow = {
  id: string;
  order: number;
  parentId?: string;
  position: {
    x: number;
    y: number;
  };
  definition: WorkbenchWindowDefinition;
};

export type WorkbenchWindowManager = {
  manager: ReturnType<typeof createWindowManager>;
  desktopWindows: Readonly<{ value: WorkbenchRuntimeWindow[] }>;
  mobileWindows: Readonly<{ value: WorkbenchRuntimeWindow[] }>;
  openSync<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchWindowDefinition<TValues, TResult>
  ): WorkbenchRuntimeWindow;
  open<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchWindowDefinition<TValues, TResult>
  ): Promise<WorkbenchWindowResult<TResult, TValues>>;
  openDialogSync<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchDialogDefinition<TValues, TResult>
  ): WorkbenchRuntimeWindow;
  openDialog<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchDialogDefinition<TValues, TResult>
  ): Promise<WorkbenchWindowResult<TResult, TValues>>;
  focus(windowId: string): WorkbenchRuntimeWindow | undefined;
  move(windowId: string, position: { x: number; y: number }): WorkbenchRuntimeWindow | undefined;
  close<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    windowId: string,
    result: WorkbenchWindowResult<TResult, TValues>
  ): void;
  closeByContext(context: WorkbenchWindowContext, result?: WorkbenchWindowResult): void;
  get(windowId: string): WorkbenchRuntimeWindow | undefined;
  snapshot(): WorkbenchRuntimeWindow[];
  visibleStack(mode: WorkbenchWindowMode): WorkbenchRuntimeWindow[];
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

function normalizeDialogDefinition<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
>(definition: WorkbenchDialogDefinition<TValues, TResult>): WorkbenchWindowDefinition<TValues, TResult> {
  return {
    ...definition,
    kind: definition.kind ?? "dialog"
  };
}

const sharedWorkbenchWindows: WorkbenchWindowManager = {
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
  openDialogSync(definition) {
    const window = manager.openSync(normalizeDialogDefinition(definition)) as WorkbenchRuntimeWindow;
    touch();
    return window;
  },
  openDialog(definition) {
    const result = manager.open(normalizeDialogDefinition(definition));
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
