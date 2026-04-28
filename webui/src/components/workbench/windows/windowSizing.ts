import type { WorkbenchWindowSize } from "./types.js";

export type WindowSizing = {
  className: string;
  style: Record<string, string>;
};

const SAFE_AREA_WIDTH = "calc(100vw - 2rem - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))";
const SAFE_AREA_HEIGHT = "calc(100dvh - 2rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))";
const MOBILE_WIDTHS: Record<Exclude<WorkbenchWindowSize, "full">, string> = {
  auto: "min(24rem, var(--workbench-window-safe-width))",
  sm: "min(20rem, var(--workbench-window-safe-width))",
  md: "min(28rem, var(--workbench-window-safe-width))",
  lg: "min(34rem, var(--workbench-window-safe-width))",
  xl: "min(38rem, var(--workbench-window-safe-width))"
};

const DESKTOP_SIZES: Record<Exclude<WorkbenchWindowSize, "full">, string> = {
  auto: "w-auto max-w-[min(92vw,24rem)]",
  sm: "w-[min(92vw,20rem)] max-w-sm",
  md: "w-[min(92vw,28rem)] max-w-md",
  lg: "w-[min(92vw,36rem)] max-w-lg",
  xl: "w-[min(92vw,44rem)] max-w-xl"
};

export function resolveWindowSizing(size: WorkbenchWindowSize, isMobile: boolean): WindowSizing {
  if (isMobile) {
    const width = size === "full"
      ? SAFE_AREA_WIDTH
      : MOBILE_WIDTHS[size as Exclude<WorkbenchWindowSize, "full">];
    return {
      className: "max-w-none",
      style: {
        "--workbench-window-safe-width": SAFE_AREA_WIDTH,
        width,
        maxWidth: SAFE_AREA_WIDTH,
        maxHeight: SAFE_AREA_HEIGHT
      }
    };
  }

  if (size === "full") {
    return {
      className: "w-full max-w-none h-full max-h-full",
      style: {
        width: SAFE_AREA_WIDTH,
        height: SAFE_AREA_HEIGHT,
        maxWidth: SAFE_AREA_WIDTH,
        maxHeight: SAFE_AREA_HEIGHT
      }
    };
  }

  return {
    className: DESKTOP_SIZES[size as Exclude<WorkbenchWindowSize, "full">],
    style: {
      maxHeight: SAFE_AREA_HEIGHT
    }
  };
}
