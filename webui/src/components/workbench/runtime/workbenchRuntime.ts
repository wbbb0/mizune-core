import { computed, inject, provide, reactive, ref, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref, type ShallowRef } from "vue";
import type { WorkbenchAreaId, WorkbenchView } from "@/components/workbench/types";

export type MobileAreaStackEntry = {
  areaId: WorkbenchAreaId;
  viewId: string;
  detailKey?: string;
};

export type DesktopAreaId = "primarySidebar";

export type WorkbenchRuntime = {
  view: ComputedRef<WorkbenchView>;
  mainRegionRef: Ref<HTMLElement | null>;
  keyboardAvoidanceBoundary: ComputedRef<HTMLElement | null>;
  getDesktopAreaWidthPx: (areaId: DesktopAreaId) => number;
  getDesktopAreaStyle: (areaId: DesktopAreaId) => { width: string };
  clampDesktopAreaWidth: (areaId: DesktopAreaId, widthPx: number) => number;
  setDesktopAreaWidth: (areaId: DesktopAreaId, widthPx: number) => void;
  resetDesktopAreaWidth: (areaId: DesktopAreaId) => void;
  mobileRootAreaId: ComputedRef<WorkbenchAreaId>;
  mobileAreaStack: Ref<MobileAreaStackEntry[]>;
  mobileTopArea: ComputedRef<MobileAreaStackEntry>;
  activeMobileAreaId: ComputedRef<WorkbenchAreaId>;
  canPopMobileArea: ComputedRef<boolean>;
  resetMobileAreaStack: () => void;
  showArea: (areaId: WorkbenchAreaId, detailKey?: string) => void;
  showRootArea: () => void;
  popMobileArea: () => boolean;
};

const workbenchRuntimeKey: InjectionKey<WorkbenchRuntime> = Symbol("workbench-runtime");
const activeWorkbenchRuntime = shallowRef<WorkbenchRuntime | null>(null);
const desktopAreaStoragePrefix = "workbench.area.desktop";
const defaultDesktopAreaSize = {
  defaultWidthPx: 260,
  minWidthPx: 180,
  maxWidthPx: 520
};

function resolveDesktopAreaStorageKey(areaId: DesktopAreaId) {
  return `${desktopAreaStoragePrefix}.${areaId}.width`;
}

function readStoredDesktopAreaWidth(areaId: DesktopAreaId): number | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.localStorage.getItem(resolveDesktopAreaStorageKey(areaId));
    if (!value) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredDesktopAreaWidth(areaId: DesktopAreaId, widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(resolveDesktopAreaStorageKey(areaId), String(widthPx));
  } catch {
    // Layout resizing remains usable when storage is unavailable.
  }
}

export function createWorkbenchRuntime(view: ComputedRef<WorkbenchView>): WorkbenchRuntime {
  const mainRegionRef = ref<HTMLElement | null>(null);
  const mobileAreaStack = ref<MobileAreaStackEntry[]>([]);
  const desktopAreaWidthsPx = reactive<Record<DesktopAreaId, number>>({
    primarySidebar: resolveInitialDesktopAreaWidth("primarySidebar")
  });
  const mobileRootAreaId = computed(() => resolveMobileRootAreaId());
  const mobileTopArea = computed(() => (
    mobileAreaStack.value[mobileAreaStack.value.length - 1]
    ?? createMobileAreaEntry(mobileRootAreaId.value)
  ));
  const activeMobileAreaId = computed(() => mobileTopArea.value.areaId);
  const canPopMobileArea = computed(() => mobileAreaStack.value.length > 1);
  const keyboardAvoidanceBoundary = computed(() => mainRegionRef.value);

  function resolveMobileRootAreaId(): WorkbenchAreaId {
    const configuredAreaId = view.value.layout.mobile.rootArea;
    if (configuredAreaId === "mainArea" || view.value.areas[configuredAreaId]) {
      return configuredAreaId;
    }
    return "mainArea";
  }

  function createMobileAreaEntry(areaId: WorkbenchAreaId, detailKey?: string): MobileAreaStackEntry {
    return {
      areaId,
      viewId: view.value.id,
      ...(detailKey === undefined ? {} : { detailKey })
    };
  }

  function resolveTargetMobileAreaId(areaId: WorkbenchAreaId): WorkbenchAreaId {
    if (areaId === "mainArea" || view.value.areas[areaId]) {
      return areaId;
    }
    return mobileRootAreaId.value;
  }

  function resolveDesktopAreaDefaultWidth(areaId: DesktopAreaId) {
    if (areaId !== "primarySidebar") {
      return defaultDesktopAreaSize.defaultWidthPx;
    }
    return view.value.layout.desktop.primarySidebar?.defaultWidthPx ?? defaultDesktopAreaSize.defaultWidthPx;
  }

  function resolveInitialDesktopAreaWidth(areaId: DesktopAreaId) {
    return clampDesktopAreaWidth(areaId, readStoredDesktopAreaWidth(areaId) ?? resolveDesktopAreaDefaultWidth(areaId));
  }

  function resolveDesktopAreaMinWidth(areaId: DesktopAreaId) {
    if (areaId !== "primarySidebar") {
      return defaultDesktopAreaSize.minWidthPx;
    }
    return view.value.layout.desktop.primarySidebar?.minWidthPx ?? defaultDesktopAreaSize.minWidthPx;
  }

  function resolveDesktopAreaMaxWidth(areaId: DesktopAreaId) {
    return Math.max(
      resolveDesktopAreaMinWidth(areaId),
      areaId === "primarySidebar"
        ? view.value.layout.desktop.primarySidebar?.maxWidthPx ?? defaultDesktopAreaSize.maxWidthPx
        : defaultDesktopAreaSize.maxWidthPx
    );
  }

  function clampDesktopAreaWidth(areaId: DesktopAreaId, widthPx: number) {
    return Math.min(
      resolveDesktopAreaMaxWidth(areaId),
      Math.max(resolveDesktopAreaMinWidth(areaId), Math.round(widthPx))
    );
  }

  function getDesktopAreaWidthPx(areaId: DesktopAreaId) {
    return desktopAreaWidthsPx[areaId];
  }

  function getDesktopAreaStyle(areaId: DesktopAreaId) {
    return {
      width: `${getDesktopAreaWidthPx(areaId)}px`
    };
  }

  function setDesktopAreaWidth(areaId: DesktopAreaId, widthPx: number) {
    const nextWidth = clampDesktopAreaWidth(areaId, widthPx);
    desktopAreaWidthsPx[areaId] = nextWidth;
    writeStoredDesktopAreaWidth(areaId, nextWidth);
  }

  function resetDesktopAreaWidth(areaId: DesktopAreaId) {
    setDesktopAreaWidth(areaId, resolveDesktopAreaDefaultWidth(areaId));
  }

  function resetMobileAreaStack() {
    mobileAreaStack.value = [createMobileAreaEntry(mobileRootAreaId.value)];
  }

  function showRootArea() {
    resetMobileAreaStack();
  }

  function showArea(areaId: WorkbenchAreaId, detailKey?: string) {
    const targetAreaId = resolveTargetMobileAreaId(areaId);
    if (targetAreaId === mobileRootAreaId.value) {
      mobileAreaStack.value = [createMobileAreaEntry(targetAreaId, detailKey)];
      return;
    }
    mobileAreaStack.value = [
      createMobileAreaEntry(mobileRootAreaId.value),
      createMobileAreaEntry(targetAreaId, detailKey)
    ];
  }

  function popMobileArea() {
    if (!canPopMobileArea.value) {
      return false;
    }
    mobileAreaStack.value = mobileAreaStack.value.slice(0, -1);
    return true;
  }

  watch(() => view.value.id, () => {
    desktopAreaWidthsPx.primarySidebar = resolveInitialDesktopAreaWidth("primarySidebar");
  });

  resetMobileAreaStack();

  return {
    view,
    mainRegionRef,
    keyboardAvoidanceBoundary,
    getDesktopAreaWidthPx,
    getDesktopAreaStyle,
    clampDesktopAreaWidth,
    setDesktopAreaWidth,
    resetDesktopAreaWidth,
    mobileRootAreaId,
    mobileAreaStack,
    mobileTopArea,
    activeMobileAreaId,
    canPopMobileArea,
    resetMobileAreaStack,
    showArea,
    showRootArea,
    popMobileArea
  };
}

export function provideWorkbenchRuntime(runtime: WorkbenchRuntime): void {
  provide(workbenchRuntimeKey, runtime);
}

export function useWorkbenchRuntimeContext(): WorkbenchRuntime | null {
  return inject(workbenchRuntimeKey, null);
}

export function activateWorkbenchRuntime(runtime: WorkbenchRuntime): () => void {
  activeWorkbenchRuntime.value = runtime;
  return () => {
    if (activeWorkbenchRuntime.value === runtime) {
      activeWorkbenchRuntime.value = null;
    }
  };
}

export function useActiveWorkbenchRuntime(): ShallowRef<WorkbenchRuntime | null> {
  return activeWorkbenchRuntime;
}

export function useWorkbenchNavigation() {
  return {
    showArea(areaId: WorkbenchAreaId, detailKey?: string) {
      const runtime = activeWorkbenchRuntime.value;
      if (runtime) {
        runtime.showArea(areaId, detailKey);
      }
    },
    showRootArea() {
      const runtime = activeWorkbenchRuntime.value;
      if (runtime) {
        runtime.showRootArea();
      }
    },
    popArea() {
      return activeWorkbenchRuntime.value?.popMobileArea() ?? false;
    }
  };
}
