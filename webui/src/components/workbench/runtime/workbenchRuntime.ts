import { computed, inject, provide, reactive, ref, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref, type ShallowRef } from "vue";
import type { WorkbenchSection } from "@/components/workbench/types";

export type MobileRegionStackEntry =
  | { kind: "list"; sectionId: string }
  | { kind: "main"; sectionId: string; detailKey?: string };

export type DesktopPaneId = "list";

export type WorkbenchRuntime = {
  section: ComputedRef<WorkbenchSection>;
  mainRegionRef: Ref<HTMLElement | null>;
  keyboardAvoidanceBoundary: ComputedRef<HTMLElement | null>;
  getDesktopPaneWidthPx: (paneId: DesktopPaneId) => number;
  getDesktopPaneStyle: (paneId: DesktopPaneId) => { width: string };
  clampDesktopPaneWidth: (paneId: DesktopPaneId, widthPx: number) => number;
  setDesktopPaneWidth: (paneId: DesktopPaneId, widthPx: number) => void;
  resetDesktopPaneWidth: (paneId: DesktopPaneId) => void;
  hasMobileListFlow: ComputedRef<boolean>;
  mobileStack: Ref<MobileRegionStackEntry[]>;
  mobileTop: ComputedRef<MobileRegionStackEntry>;
  isMobileMainVisible: ComputedRef<boolean>;
  canPopMobileRegion: ComputedRef<boolean>;
  resetMobileStack: () => void;
  showList: () => void;
  showMain: (detailKey?: string) => void;
  popMobileRegion: () => boolean;
};

const workbenchRuntimeKey: InjectionKey<WorkbenchRuntime> = Symbol("workbench-runtime");
const activeWorkbenchRuntime = shallowRef<WorkbenchRuntime | null>(null);
const desktopPaneStoragePrefix = "workbench.pane.desktop";
const defaultDesktopPaneSize = {
  defaultWidthPx: 260,
  minWidthPx: 180,
  maxWidthPx: 520
};

function resolveDesktopPaneStorageKey(paneId: DesktopPaneId) {
  return `${desktopPaneStoragePrefix}.${paneId}.width`;
}

function readStoredDesktopPaneWidth(paneId: DesktopPaneId): number | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.localStorage.getItem(resolveDesktopPaneStorageKey(paneId));
    if (!value) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredDesktopPaneWidth(paneId: DesktopPaneId, widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(resolveDesktopPaneStorageKey(paneId), String(widthPx));
  } catch {
    // Layout resizing remains usable when storage is unavailable.
  }
}

export function createWorkbenchRuntime(section: ComputedRef<WorkbenchSection>): WorkbenchRuntime {
  const mainRegionRef = ref<HTMLElement | null>(null);
  const mobileStack = ref<MobileRegionStackEntry[]>([]);
  const desktopPaneWidthsPx = reactive<Record<DesktopPaneId, number>>({
    list: resolveInitialDesktopPaneWidth("list")
  });
  const hasMobileListFlow = computed(() => section.value.layout.mobile.mainFlow !== "main-only");
  const mobileTop = computed(() => mobileStack.value[mobileStack.value.length - 1] ?? { kind: "list", sectionId: section.value.id });
  const isMobileMainVisible = computed(() => mobileTop.value.kind === "main");
  const canPopMobileRegion = computed(() => hasMobileListFlow.value && mobileStack.value.length > 1);
  const keyboardAvoidanceBoundary = computed(() => mainRegionRef.value);

  function resolveDesktopPaneDefaultWidth(paneId: DesktopPaneId) {
    if (paneId !== "list") {
      return defaultDesktopPaneSize.defaultWidthPx;
    }
    return section.value.layout.desktop.listPane?.defaultWidthPx ?? defaultDesktopPaneSize.defaultWidthPx;
  }

  function resolveInitialDesktopPaneWidth(paneId: DesktopPaneId) {
    return clampDesktopPaneWidth(paneId, readStoredDesktopPaneWidth(paneId) ?? resolveDesktopPaneDefaultWidth(paneId));
  }

  function resolveDesktopPaneMinWidth(paneId: DesktopPaneId) {
    if (paneId !== "list") {
      return defaultDesktopPaneSize.minWidthPx;
    }
    return section.value.layout.desktop.listPane?.minWidthPx ?? defaultDesktopPaneSize.minWidthPx;
  }

  function resolveDesktopPaneMaxWidth(paneId: DesktopPaneId) {
    return Math.max(
      resolveDesktopPaneMinWidth(paneId),
      paneId === "list"
        ? section.value.layout.desktop.listPane?.maxWidthPx ?? defaultDesktopPaneSize.maxWidthPx
        : defaultDesktopPaneSize.maxWidthPx
    );
  }

  function clampDesktopPaneWidth(paneId: DesktopPaneId, widthPx: number) {
    return Math.min(
      resolveDesktopPaneMaxWidth(paneId),
      Math.max(resolveDesktopPaneMinWidth(paneId), Math.round(widthPx))
    );
  }

  function getDesktopPaneWidthPx(paneId: DesktopPaneId) {
    return desktopPaneWidthsPx[paneId];
  }

  function getDesktopPaneStyle(paneId: DesktopPaneId) {
    return {
      width: `${getDesktopPaneWidthPx(paneId)}px`
    };
  }

  function setDesktopPaneWidth(paneId: DesktopPaneId, widthPx: number) {
    const nextWidth = clampDesktopPaneWidth(paneId, widthPx);
    desktopPaneWidthsPx[paneId] = nextWidth;
    writeStoredDesktopPaneWidth(paneId, nextWidth);
  }

  function resetDesktopPaneWidth(paneId: DesktopPaneId) {
    setDesktopPaneWidth(paneId, resolveDesktopPaneDefaultWidth(paneId));
  }

  function resetMobileStack() {
    mobileStack.value = !hasMobileListFlow.value
      ? [{ kind: "main", sectionId: section.value.id }]
      : [{ kind: "list", sectionId: section.value.id }];
  }

  function showList() {
    if (!hasMobileListFlow.value) {
      resetMobileStack();
      return;
    }
    mobileStack.value = [{ kind: "list", sectionId: section.value.id }];
  }

  function showMain(detailKey?: string) {
    if (!hasMobileListFlow.value) {
      mobileStack.value = [{ kind: "main", sectionId: section.value.id, detailKey }];
      return;
    }
    mobileStack.value = [
      { kind: "list", sectionId: section.value.id },
      { kind: "main", sectionId: section.value.id, detailKey }
    ];
  }

  function popMobileRegion() {
    if (!canPopMobileRegion.value) {
      return false;
    }
    mobileStack.value = mobileStack.value.slice(0, -1);
    return true;
  }

  watch(() => section.value.id, () => {
    desktopPaneWidthsPx.list = resolveInitialDesktopPaneWidth("list");
  });

  resetMobileStack();

  return {
    section,
    mainRegionRef,
    keyboardAvoidanceBoundary,
    getDesktopPaneWidthPx,
    getDesktopPaneStyle,
    clampDesktopPaneWidth,
    setDesktopPaneWidth,
    resetDesktopPaneWidth,
    hasMobileListFlow,
    mobileStack,
    mobileTop,
    isMobileMainVisible,
    canPopMobileRegion,
    resetMobileStack,
    showList,
    showMain,
    popMobileRegion
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
    showList() {
      const runtime = activeWorkbenchRuntime.value;
      if (runtime) {
        runtime.showList();
      }
    },
    showMain(detailKey?: string) {
      const runtime = activeWorkbenchRuntime.value;
      if (runtime) {
        runtime.showMain(detailKey);
      }
    },
    popMobileRegion() {
      return activeWorkbenchRuntime.value?.popMobileRegion() ?? false;
    }
  };
}
