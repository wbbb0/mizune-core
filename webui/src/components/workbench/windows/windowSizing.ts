import type { WindowSize } from "./types.js";

export type WindowSizing = {
  className: string;
  style: Record<string, string>;
};

const SAFE_AREA_WIDTH = "calc(100vw - 2rem - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))";
const SAFE_AREA_HEIGHT = "calc(100dvh - 2rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))";

const DESKTOP_SIZES: Record<Exclude<WindowSize, "full">, string> = {
  auto: "w-auto max-w-[min(92vw,24rem)]",
  sm: "w-[min(92vw,20rem)] max-w-sm",
  md: "w-[min(92vw,28rem)] max-w-md",
  lg: "w-[min(92vw,36rem)] max-w-lg",
  xl: "w-[min(92vw,44rem)] max-w-xl"
};

export function resolveWindowSizing(size: WindowSize, isMobile: boolean): WindowSizing {
  if (isMobile) {
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
    className: DESKTOP_SIZES[size as Exclude<WindowSize, "full">],
    style: {
      maxHeight: SAFE_AREA_HEIGHT
    }
  };
}
