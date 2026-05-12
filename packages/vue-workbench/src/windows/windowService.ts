import { computed, ref } from "vue";
import type {
  WorkbenchWindowBounds,
  WorkbenchDialogDefinition,
  WorkbenchWindowContext,
  WorkbenchWindowDefinition,
  WorkbenchWindowMaximizePayload,
  WorkbenchWindowSizedBounds,
  WorkbenchWindowSizePx,
  WorkbenchWindowResult
} from "./types.js";
import { createWindowManager } from "./windowManager.js";

type WorkbenchWindowMode = "desktop" | "mobile";

/** 当前运行时中的窗口实例。 */
export type WorkbenchRuntimeWindow = {
  id: string;
  order: number;
  parentId?: string;
  position: {
    x: number;
    y: number;
  };
  sizePx?: WorkbenchWindowSizePx;
  maximized: boolean;
  restoreBounds?: WorkbenchWindowSizedBounds;
  definition: WorkbenchWindowDefinition;
};

/** WorkbenchRoot 提供的窗口管理服务。 */
export type WorkbenchWindowManager = {
  desktopWindows: Readonly<{ value: WorkbenchRuntimeWindow[] }>;
  mobileWindows: Readonly<{ value: WorkbenchRuntimeWindow[] }>;
  /** 同步打开窗口并返回运行时窗口实例，不等待关闭结果。 */
  openSync<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchWindowDefinition<TValues, TResult>
  ): WorkbenchRuntimeWindow;
  /** 打开窗口并等待关闭结果。 */
  open<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchWindowDefinition<TValues, TResult>
  ): Promise<WorkbenchWindowResult<TResult, TValues>>;
  /** 同步打开 dialog，kind 默认补为 dialog。 */
  openDialogSync<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchDialogDefinition<TValues, TResult>
  ): WorkbenchRuntimeWindow;
  /** 打开 dialog 并等待 action/close/dismiss 结果。 */
  openDialog<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchDialogDefinition<TValues, TResult>
  ): Promise<WorkbenchWindowResult<TResult, TValues>>;
  focus(windowId: string): WorkbenchRuntimeWindow | undefined;
  move(windowId: string, position: { x: number; y: number }): WorkbenchRuntimeWindow | undefined;
  setBounds(windowId: string, bounds: WorkbenchWindowBounds): WorkbenchRuntimeWindow | undefined;
  setMaximized(windowId: string, payload: WorkbenchWindowMaximizePayload): WorkbenchRuntimeWindow | undefined;
  close<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    windowId: string,
    result: WorkbenchWindowResult<TResult, TValues>
  ): void;
  closeByContext(context: WorkbenchWindowContext, result?: WorkbenchWindowResult): void;
  get(windowId: string): WorkbenchRuntimeWindow | undefined;
  snapshot(): WorkbenchRuntimeWindow[];
  visibleStack(mode: WorkbenchWindowMode): WorkbenchRuntimeWindow[];
};

export function createWorkbenchWindowService(): WorkbenchWindowManager {
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

  return {
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
    setBounds(windowId, bounds) {
      const window = manager.setBounds(windowId, bounds) as WorkbenchRuntimeWindow | undefined;
      touch();
      return window;
    },
    setMaximized(windowId, payload) {
      const window = manager.setMaximized(windowId, payload) as WorkbenchRuntimeWindow | undefined;
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
}
