import { computed, inject, provide, ref, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref, type ShallowRef } from "vue";
import type { WorkbenchSection } from "@/components/workbench/types";

export type MobileRegionStackEntry =
  | { kind: "list"; sectionId: string }
  | { kind: "main"; sectionId: string; detailKey?: string };

export type WorkbenchRuntime = {
  section: ComputedRef<WorkbenchSection>;
  mainRegionRef: Ref<HTMLElement | null>;
  keyboardAvoidanceBoundary: ComputedRef<HTMLElement | null>;
  desktopListPaneWidthPx: Ref<number>;
  desktopListPaneStyle: ComputedRef<{ width: string }>;
  clampDesktopListPaneWidth: (widthPx: number) => number;
  setDesktopListPaneWidth: (widthPx: number) => void;
  resetDesktopListPaneWidth: () => void;
  mobileStack: Ref<MobileRegionStackEntry[]>;
  mobileTop: ComputedRef<MobileRegionStackEntry>;
  isMobileMainVisible: ComputedRef<boolean>;
  resetMobileStack: () => void;
  showList: () => void;
  showMain: (detailKey?: string) => void;
  popMobileRegion: () => boolean;
};

const workbenchRuntimeKey: InjectionKey<WorkbenchRuntime> = Symbol("workbench-runtime");
const activeWorkbenchRuntime = shallowRef<WorkbenchRuntime | null>(null);
const desktopListPaneStoragePrefix = "workbench.pane.desktopList";
const defaultDesktopListPane = {
  defaultWidthPx: 260,
  minWidthPx: 180,
  maxWidthPx: 520
};

function resolveDesktopListPaneStorageKey(sectionId: string) {
  return `${desktopListPaneStoragePrefix}.${sectionId}`;
}

function readStoredDesktopListPaneWidth(sectionId: string): number | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.localStorage.getItem(resolveDesktopListPaneStorageKey(sectionId));
    if (!value) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredDesktopListPaneWidth(sectionId: string, widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(resolveDesktopListPaneStorageKey(sectionId), String(widthPx));
  } catch {
    // Layout resizing remains usable when storage is unavailable.
  }
}

export function createWorkbenchRuntime(section: ComputedRef<WorkbenchSection>): WorkbenchRuntime {
  const mainRegionRef = ref<HTMLElement | null>(null);
  const mobileStack = ref<MobileRegionStackEntry[]>([]);
  const desktopListPaneWidthPx = ref(resolveInitialDesktopListPaneWidth());
  const mobileTop = computed(() => mobileStack.value[mobileStack.value.length - 1] ?? { kind: "list", sectionId: section.value.id });
  const isMobileMainVisible = computed(() => mobileTop.value.kind === "main");
  const keyboardAvoidanceBoundary = computed(() => mainRegionRef.value);
  const desktopListPaneStyle = computed(() => ({
    width: `${desktopListPaneWidthPx.value}px`
  }));

  function resolveDesktopListPaneDefaultWidth() {
    return section.value.layout.desktop.listPane?.defaultWidthPx ?? defaultDesktopListPane.defaultWidthPx;
  }

  function resolveInitialDesktopListPaneWidth() {
    return clampDesktopListPaneWidth(readStoredDesktopListPaneWidth(section.value.id) ?? resolveDesktopListPaneDefaultWidth());
  }

  function resolveDesktopListPaneMinWidth() {
    return section.value.layout.desktop.listPane?.minWidthPx ?? defaultDesktopListPane.minWidthPx;
  }

  function resolveDesktopListPaneMaxWidth() {
    return Math.max(
      resolveDesktopListPaneMinWidth(),
      section.value.layout.desktop.listPane?.maxWidthPx ?? defaultDesktopListPane.maxWidthPx
    );
  }

  function clampDesktopListPaneWidth(widthPx: number) {
    return Math.min(
      resolveDesktopListPaneMaxWidth(),
      Math.max(resolveDesktopListPaneMinWidth(), Math.round(widthPx))
    );
  }

  function setDesktopListPaneWidth(widthPx: number) {
    const nextWidth = clampDesktopListPaneWidth(widthPx);
    desktopListPaneWidthPx.value = nextWidth;
    writeStoredDesktopListPaneWidth(section.value.id, nextWidth);
  }

  function resetDesktopListPaneWidth() {
    setDesktopListPaneWidth(resolveDesktopListPaneDefaultWidth());
  }

  function resetMobileStack() {
    mobileStack.value = section.value.layout.mobile.mainFlow === "main-only"
      ? [{ kind: "main", sectionId: section.value.id }]
      : [{ kind: "list", sectionId: section.value.id }];
  }

  function showList() {
    mobileStack.value = [{ kind: "list", sectionId: section.value.id }];
  }

  function showMain(detailKey?: string) {
    mobileStack.value = [
      { kind: "list", sectionId: section.value.id },
      { kind: "main", sectionId: section.value.id, detailKey }
    ];
  }

  function popMobileRegion() {
    if (mobileStack.value.length <= 1) {
      return false;
    }
    mobileStack.value = mobileStack.value.slice(0, -1);
    return true;
  }

  watch(() => section.value.id, () => {
    desktopListPaneWidthPx.value = resolveInitialDesktopListPaneWidth();
  });

  resetMobileStack();

  return {
    section,
    mainRegionRef,
    keyboardAvoidanceBoundary,
    desktopListPaneWidthPx,
    desktopListPaneStyle,
    clampDesktopListPaneWidth,
    setDesktopListPaneWidth,
    resetDesktopListPaneWidth,
    mobileStack,
    mobileTop,
    isMobileMainVisible,
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
