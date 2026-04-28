import type { WorkbenchWindowContext, WorkbenchWindowDefinition, WorkbenchWindowResult } from "./types.js";

type WorkbenchWindowPosition = {
  x: number;
  y: number;
};

type ManagedWorkbenchWindow<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
> = {
  id: string;
  order: number;
  parentId?: string;
  position: WorkbenchWindowPosition;
  definition: WorkbenchWindowDefinition<TValues, TResult>;
};

type WorkbenchWindowMode = "desktop" | "mobile";

type WorkbenchWindowStore = {
  openSync<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchWindowDefinition<TValues, TResult>
  ): ManagedWorkbenchWindow<TValues, TResult>;
  open<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchWindowDefinition<TValues, TResult>
  ): Promise<WorkbenchWindowResult<TResult, TValues>>;
  focus(windowId: string): ManagedWorkbenchWindow | undefined;
  move(windowId: string, position: WorkbenchWindowPosition): ManagedWorkbenchWindow | undefined;
  close<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    windowId: string,
    result: WorkbenchWindowResult<TResult, TValues>
  ): void;
  closeByContext(context: WorkbenchWindowContext, result?: WorkbenchWindowResult): void;
  get(windowId: string): ManagedWorkbenchWindow | undefined;
  snapshot(): ManagedWorkbenchWindow[];
  visibleStack(mode: WorkbenchWindowMode): ManagedWorkbenchWindow[];
};

function cloneDefinition<TValues extends Record<string, unknown>, TResult>(
  definition: WorkbenchWindowDefinition<TValues, TResult>
): WorkbenchWindowDefinition<TValues, TResult> {
  const cloneValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => cloneValue(item));
    }
    if (value && typeof value === "object") {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return value;
      }
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
    }
    return value;
  };

  return cloneValue(definition) as WorkbenchWindowDefinition<TValues, TResult>;
}

function cloneWindow<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
>(window: ManagedWorkbenchWindow<TValues, TResult>): ManagedWorkbenchWindow<TValues, TResult> {
  return {
    id: window.id,
    order: window.order,
    position: { ...window.position },
    definition: cloneDefinition(window.definition),
    ...(window.parentId ? { parentId: window.parentId } : {})
  };
}

function createDismissResult(): WorkbenchWindowResult<unknown, Record<string, unknown>> {
  return {
    reason: "dismiss",
    values: {}
  };
}

function sameWindowContext(a: WorkbenchWindowContext | undefined, b: WorkbenchWindowContext) {
  return a?.kind === b.kind && a.id === b.id;
}

export function createWindowManager(): WorkbenchWindowStore {
  const windows: ManagedWorkbenchWindow[] = [];
  const resolvers = new Map<string, (result: WorkbenchWindowResult) => void>();
  let nextWindowIndex = 1;

  function buildWindowId<TValues extends Record<string, unknown>, TResult>(
    definition: WorkbenchWindowDefinition<TValues, TResult>
  ) {
    return definition.id ?? `window-${nextWindowIndex++}`;
  }

  function findWindowIndex(windowId: string) {
    return windows.findIndex((window) => window.id === windowId);
  }

  function getWindow(windowId: string) {
    return windows.find((window) => window.id === windowId);
  }

  function getWindowMap() {
    return new Map(windows.map((window) => [window.id, window] as const));
  }

  function isDescendantOf(ancestorId: string, windowId: string) {
    const windowMap = getWindowMap();
    let current = windowMap.get(windowId);

    while (current?.parentId) {
      if (current.parentId === ancestorId) {
        return true;
      }
      current = windowMap.get(current.parentId);
    }

    return false;
  }

  function collectDescendantIds(windowId: string) {
    return windows
      .filter((candidate) => isDescendantOf(windowId, candidate.id))
      .map((candidate) => candidate.id);
  }

  function resequenceOrders() {
    windows.forEach((window, index) => {
      window.order = index + 1;
    });
  }

  function placeWindow(windowId: string) {
    const currentIndex = findWindowIndex(windowId);
    if (currentIndex === -1) {
      throw new Error(`Unknown window: ${windowId}`);
    }

    const [window] = windows.splice(currentIndex, 1);
    if (!window) {
      throw new Error(`Unknown window: ${windowId}`);
    }
    const descendantIndexes = windows
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => isDescendantOf(windowId, candidate.id))
      .map(({ index }) => index);

    const insertIndex = descendantIndexes.length > 0 ? Math.min(...descendantIndexes) : windows.length;
    windows.splice(insertIndex, 0, window);
    resequenceOrders();

    return window;
  }

  function openSync<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchWindowDefinition<TValues, TResult>
  ) {
    const id = buildWindowId(definition);
    if (getWindow(id)) {
      throw new Error(`Duplicate window id: ${id}`);
    }

    const storedDefinition = cloneDefinition(definition);
    windows.push({
      id,
      order: windows.length + 1,
      position: { x: 0, y: 0 },
      definition: storedDefinition as WorkbenchWindowDefinition,
      ...(storedDefinition.parentId ? { parentId: storedDefinition.parentId } : {})
    });

    placeWindow(id);
    const openedWindow = getWindow(id);
    if (!openedWindow) {
      throw new Error(`Unknown window: ${id}`);
    }
    return cloneWindow(openedWindow as ManagedWorkbenchWindow<TValues, TResult>);
  }

  function open<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WorkbenchWindowDefinition<TValues, TResult>
  ) {
    const window = openSync(definition);
    return new Promise<WorkbenchWindowResult<TResult, TValues>>((resolve) => {
      resolvers.set(window.id, resolve as (result: WorkbenchWindowResult) => void);
    });
  }

  function focus(windowId: string) {
    const window = placeWindow(windowId);
    return cloneWindow(window);
  }

  function move(windowId: string, position: WorkbenchWindowPosition) {
    const window = getWindow(windowId);
    if (!window) {
      throw new Error(`Unknown window: ${windowId}`);
    }

    window.position = { ...position };
    return cloneWindow(window);
  }

  function close<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    windowId: string,
    result: WorkbenchWindowResult<TResult, TValues>
  ) {
    if (!getWindow(windowId)) {
      throw new Error(`Unknown window: ${windowId}`);
    }

    const descendantIds = collectDescendantIds(windowId);
    for (const descendantId of descendantIds) {
      const descendantIndex = findWindowIndex(descendantId);
      if (descendantIndex !== -1) {
        windows.splice(descendantIndex, 1);
      }

      const descendantResolve = resolvers.get(descendantId);
      if (descendantResolve) {
        resolvers.delete(descendantId);
        descendantResolve(createDismissResult());
      }
    }

    const index = findWindowIndex(windowId);
    if (index !== -1) {
      windows.splice(index, 1);
    }
    resequenceOrders();

    const resolve = resolvers.get(windowId);
    if (resolve) {
      resolvers.delete(windowId);
      resolve(result as WorkbenchWindowResult);
    }
  }

  function closeByContext(context: WorkbenchWindowContext, result: WorkbenchWindowResult = createDismissResult()) {
    const matchingWindowIds = windows
      .filter((window) => sameWindowContext(window.definition.context, context))
      .map((window) => window.id);

    for (const windowId of matchingWindowIds) {
      if (getWindow(windowId)) {
        close(windowId, result);
      }
    }
  }

  function get(windowId: string) {
    const window = getWindow(windowId);
    return window ? cloneWindow(window) : undefined;
  }

  function snapshot() {
    return windows.map(cloneWindow);
  }

  function visibleStack(mode: WorkbenchWindowMode) {
    if (mode === "mobile") {
      const topWindow = windows[windows.length - 1];
      return topWindow ? [cloneWindow(topWindow)] : [];
    }

    return snapshot();
  }

  return {
    openSync,
    open,
    focus,
    move,
    close,
    closeByContext,
    get,
    snapshot,
    visibleStack
  };
}
