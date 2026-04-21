import type { WindowDefinition, WindowResult } from "../../components/workbench/windows/types.js";

type WindowPosition = {
  x: number;
  y: number;
};

type RuntimeWindow<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
> = {
  id: string;
  order: number;
  parentId?: string;
  position: WindowPosition;
  definition: WindowDefinition<TValues, TResult>;
};

type WindowManagerMode = "desktop" | "mobile";

type WindowManager = {
  openSync<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WindowDefinition<TValues, TResult>
  ): RuntimeWindow<TValues, TResult>;
  open<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WindowDefinition<TValues, TResult>
  ): Promise<WindowResult<TResult, TValues>>;
  focus(windowId: string): RuntimeWindow | undefined;
  move(windowId: string, position: WindowPosition): RuntimeWindow | undefined;
  close<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    windowId: string,
    result: WindowResult<TResult, TValues>
  ): void;
  get(windowId: string): RuntimeWindow | undefined;
  snapshot(): RuntimeWindow[];
  visibleStack(mode: WindowManagerMode): RuntimeWindow[];
};

function cloneDefinition<TValues extends Record<string, unknown>, TResult>(
  definition: WindowDefinition<TValues, TResult>
): WindowDefinition<TValues, TResult> {
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

  return cloneValue(definition) as WindowDefinition<TValues, TResult>;
}

function cloneWindow<
  TValues extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown
>(window: RuntimeWindow<TValues, TResult>): RuntimeWindow<TValues, TResult> {
  return {
    id: window.id,
    order: window.order,
    position: { ...window.position },
    definition: cloneDefinition(window.definition),
    ...(window.parentId ? { parentId: window.parentId } : {})
  };
}

function createDismissResult(): WindowResult<unknown, Record<string, unknown>> {
  return {
    reason: "dismiss",
    values: {}
  };
}

export function createWindowManager(): WindowManager {
  const windows: RuntimeWindow[] = [];
  const resolvers = new Map<string, (result: WindowResult) => void>();
  let nextWindowIndex = 1;

  function buildWindowId<TValues extends Record<string, unknown>, TResult>(
    definition: WindowDefinition<TValues, TResult>
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
    definition: WindowDefinition<TValues, TResult>
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
      definition: storedDefinition as WindowDefinition,
      ...(storedDefinition.parentId ? { parentId: storedDefinition.parentId } : {})
    });

    placeWindow(id);
    const openedWindow = getWindow(id);
    if (!openedWindow) {
      throw new Error(`Unknown window: ${id}`);
    }
    return cloneWindow(openedWindow as RuntimeWindow<TValues, TResult>);
  }

  function open<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    definition: WindowDefinition<TValues, TResult>
  ) {
    const window = openSync(definition);
    return new Promise<WindowResult<TResult, TValues>>((resolve) => {
      resolvers.set(window.id, resolve as (result: WindowResult) => void);
    });
  }

  function focus(windowId: string) {
    const window = placeWindow(windowId);
    return cloneWindow(window);
  }

  function move(windowId: string, position: WindowPosition) {
    const window = getWindow(windowId);
    if (!window) {
      throw new Error(`Unknown window: ${windowId}`);
    }

    window.position = { ...position };
    return cloneWindow(window);
  }

  function close<TValues extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(
    windowId: string,
    result: WindowResult<TResult, TValues>
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
      resolve(result as WindowResult);
    }
  }

  function get(windowId: string) {
    const window = getWindow(windowId);
    return window ? cloneWindow(window) : undefined;
  }

  function snapshot() {
    return windows.map(cloneWindow);
  }

  function visibleStack(mode: WindowManagerMode) {
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
    get,
    snapshot,
    visibleStack
  };
}
