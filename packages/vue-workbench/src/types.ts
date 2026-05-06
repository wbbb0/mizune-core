import type { Component } from "vue";

/** Workbench 内置区域 ID。业务 view 通过这些 ID 声明 pane 内容和移动端跳转目标。 */
export type WorkbenchAreaId = "primarySidebar" | "mainArea" | "secondarySidebar" | "bottomPanel";
export type WorkbenchDesktopAreaId = Exclude<WorkbenchAreaId, "mainArea">;

/** 桌面 pane 尺寸约束，单位为 px。 */
export type WorkbenchAreaSize = {
  /** 首次进入 view 或双击分隔条重置时使用的尺寸。 */
  defaultSizePx?: number;
  /** 用户拖拽 pane 时允许的最小尺寸。 */
  minSizePx?: number;
  /** 用户拖拽 pane 时允许的最大尺寸。 */
  maxSizePx?: number;
};

/** 同一 view 在移动端和桌面端的布局约束。 */
export type WorkbenchViewLayout = {
  mobile: {
    /** 移动端根区域。其他区域会作为覆盖层进入 mobile area stack。 */
    rootArea: WorkbenchAreaId;
  };
  desktop: {
    primarySidebar?: WorkbenchAreaSize;
    secondarySidebar?: WorkbenchAreaSize;
    bottomPanel?: WorkbenchAreaSize;
  };
};

/** 一个业务 view 可提供的渲染区域。`mainArea` 必填，其余区域按需启用。 */
export type WorkbenchViewAreas = {
  primarySidebar?: Component;
  mainArea: Component;
  secondarySidebar?: Component;
  bottomPanel?: Component;
  mobileHeader?: Component;
};

/** WorkbenchRoot 的核心页面描述。业务项目通常通过 defineWorkbenchView 创建。 */
export type WorkbenchView = {
  id: string;
  title: string;
  areas: WorkbenchViewAreas;
  layout: WorkbenchViewLayout;
};

/** 业务项目传入的 view 定义。layout 可省略，defineWorkbenchView 会补默认值。 */
export type WorkbenchViewDefinition = Omit<WorkbenchView, "layout"> & {
  layout?: Partial<{
    mobile: Partial<WorkbenchViewLayout["mobile"]>;
    desktop: Partial<WorkbenchViewLayout["desktop"]>;
  }>;
};

/** Workbench 默认布局：移动端 rootArea 默认为 primarySidebar；若 view 未提供该区域，runtime 会回退到 mainArea。 */
export const defaultWorkbenchViewLayout: WorkbenchViewLayout = {
  mobile: {
    rootArea: "primarySidebar"
  },
  desktop: {
    primarySidebar: {}
  }
};

/** 标准化业务 view 定义，补齐移动端和桌面端布局默认值。 */
export function defineWorkbenchView(definition: WorkbenchViewDefinition): WorkbenchView {
  return {
    ...definition,
    layout: {
      mobile: {
        ...defaultWorkbenchViewLayout.mobile,
        ...definition.layout?.mobile
      },
      desktop: {
        ...defaultWorkbenchViewLayout.desktop,
        ...definition.layout?.desktop
      }
    }
  };
}
